// ============================================================
//  CopyTrader Web Server v6.0
//  FREE Copy Trading — No CopyFactory needed!
//  Uses MetaAPI free tier:
//  - Connect MT5 accounts (free)
//  - Stream master positions (free)  
//  - Place trades on slave (free)
//  = Full copy trading FREE!
// ============================================================

const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const crypto     = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ============================================================
const METAAPI_TOKEN = process.env.METAAPI_TOKEN || "YOUR_TOKEN";
const SECRET        = process.env.SECRET        || "JEEVAN_SUPER_SECRET_2026";
const ADMIN_PASS    = process.env.ADMIN_PASS    || "JEEVAN";
// ============================================================

const db = {
  masters: {},
  slaves:  {},
  copyJobs: {},
  masterData: {} // { masterName: { positions, equity, ... } }
};

// ── MetaAPI load ─────────────────────────────────────────────
let MetaApi;
async function loadMetaAPI() {
  try {
    const sdk = require('metaapi.cloud-sdk');
    MetaApi = sdk.default || sdk.MetaApi;
    console.log('✅ MetaAPI SDK loaded');
  } catch(e) {
    console.log('⚠️ MetaAPI not loaded:', e.message);
  }
}

// ── Key helpers ───────────────────────────────────────────────
function generateSig(name, dateStr) {
  return crypto.createHash('sha256')
    .update(`${name}_${dateStr}_${SECRET}`)
    .digest('hex').substring(0,4).toUpperCase();
}
function addDays(n) {
  const d = new Date(); d.setDate(d.getDate()+parseInt(n));
  return d.toISOString().split('T')[0].replace(/-/g,'');
}
function addMonths(n) {
  const d = new Date(); d.setMonth(d.getMonth()+parseInt(n));
  return d.toISOString().split('T')[0].replace(/-/g,'');
}
function makeKey(name, dateStr) {
  return `${name}_${dateStr}_${generateSig(name,dateStr)}`;
}
function verifyKey(key) {
  const parts = key.split('_');
  if(parts.length < 3) return null;
  const sig  = parts[parts.length-1];
  const date = parts[parts.length-2];
  const name = parts.slice(0,parts.length-2).join('_');
  if(!/^\d{8}$/.test(date)) return null;
  if(generateSig(name,date) !== sig.toUpperCase()) return null;
  const expiry   = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  const today    = new Date().toISOString().split('T')[0];
  const daysLeft = Math.ceil((new Date(expiry)-new Date())/(1000*60*60*24));
  return { name, expiry, daysLeft, valid: today <= expiry };
}

function authKey(req, res, next) {
  const key = req.body?.apiKey || req.query?.apiKey;
  if(!key) return res.status(401).json({error:'API key required'});
  const client = verifyKey(key);
  if(!client) return res.status(401).json({error:'Invalid API key'});
  if(!client.valid) return res.status(403).json({error:'License expired! Contact admin.', expiry:client.expiry});
  req.client = client;
  next();
}

// ── Connect MT5 via MetaAPI ───────────────────────────────────
async function connectMT5(login, password, server, name) {
  if(!MetaApi || METAAPI_TOKEN === 'YOUR_TOKEN' || METAAPI_TOKEN === 'placeholder')
    throw new Error('MetaAPI token not configured');

  const api = new MetaApi(METAAPI_TOKEN);

  // Check if account already exists
  const accounts = await api.metatraderAccountApi.getAccounts();
  let account = accounts.find(a => a.login === login.toString());

  if(!account) {
    account = await api.metatraderAccountApi.createAccount({
      name:     name,
      type:     'cloud',
      login:    login.toString(),
      password: password,
      server:   server,
      platform: 'mt5',
      magic:    12345
    });
  }

  if(account.state !== 'DEPLOYED') await account.deploy();
  await account.waitConnected();
  return account;
}

// ── OUR OWN Copy Engine ───────────────────────────────────────
// MetaAPI free tier use chesi manual copy!
async function startCopyEngine(slaveId) {
  const slave  = db.slaves[slaveId];
  const master = db.masters[slave.masterId];
  if(!slave || !master) return;

  console.log(`🔄 Copy engine starting: ${master.name} → ${slave.name}`);

  // Get MetaAPI connections
  const api = new MetaApi(METAAPI_TOKEN);

  try {
    const masterAccount = await api.metatraderAccountApi.getAccount(master.metaAccountId);
    const slaveAccount  = await api.metatraderAccountApi.getAccount(slave.metaAccountId);

    const masterConn = masterAccount.getRPCConnection();
    const slaveConn  = slaveAccount.getRPCConnection();

    await masterConn.connect();
    await slaveConn.connect();
    await masterConn.waitSynchronized();
    await slaveConn.waitSynchronized();

    // Get master equity for lot scaling
    const masterInfo = await masterConn.getAccountInformation();
    const slaveInfo  = await slaveConn.getAccountInformation();
    const lotRatio   = slaveInfo.equity / masterInfo.equity;

    let lastPositions = {};

    // Poll master every 2 seconds
    const intervalId = setInterval(async () => {
      try {
        const masterPositions = await masterConn.getPositions();
        const currentTickets  = new Set(masterPositions.map(p => p.id));

        // Open new copies
        for(const pos of masterPositions) {
          if(lastPositions[pos.id]) continue; // Already copied

          const lot = Math.max(0.01, Math.round(pos.volume * lotRatio * 100) / 100);

          try {
            if(pos.type === 'POSITION_TYPE_BUY') {
              await slaveConn.createMarketBuyOrder(pos.symbol, lot, null, null, {comment:`COPY_${pos.id}`});
            } else {
              await slaveConn.createMarketSellOrder(pos.symbol, lot, null, null, {comment:`COPY_${pos.id}`});
            }
            lastPositions[pos.id] = true;
            console.log(`✅ Copied: ${pos.type} ${pos.symbol} lot=${lot}`);
            db.slaves[slaveId].copiedCount = (db.slaves[slaveId].copiedCount || 0) + 1;
          } catch(e) {
            console.log(`❌ Copy failed: ${e.message}`);
          }
        }

        // Close orphan copies
        const slavePositions = await slaveConn.getPositions();
        for(const sPos of slavePositions) {
          if(!sPos.comment?.startsWith('COPY_')) continue;
          const masterTicket = sPos.comment.replace('COPY_','');
          if(!currentTickets.has(masterTicket)) {
            await slaveConn.closePosition(sPos.id);
            delete lastPositions[masterTicket];
            console.log(`🔴 Closed orphan: ${sPos.symbol}`);
          }
        }
      } catch(e) {
        console.log(`⚠️ Copy engine error: ${e.message}`);
      }
    }, 2000);

    db.copyJobs[slaveId] = intervalId;
    db.slaves[slaveId].status = 'copying';
    console.log(`✅ Copy engine running for slave: ${slave.name}`);

  } catch(e) {
    console.log(`❌ Copy engine failed: ${e.message}`);
    db.slaves[slaveId].status = 'error';
    db.slaves[slaveId].error  = e.message;
  }
}

// ── ROUTES ────────────────────────────────────────────────────

// ── EA Push/Pull Routes (EA directly uses these) ──────────────
// Master EA → POST /push?id=VASANTHI&key=APIKEY
app.post('/push', (req, res) => {
  const apiKey   = req.query.key || req.query.apiKey || req.body.key || req.body.apiKey;
  const masterId = req.query.id  || req.query.masterId || req.body.id;
  if(!apiKey) return res.status(401).json({error:'API key required'});
  const client = verifyKey(apiKey);
  if(!client || !client.valid) return res.status(401).json({error:'Invalid or expired key'});

  const masterName = masterId || client.name;
  db.masterData[masterName] = {
    ...req.body,
    apiKey,
    lastUpdate: Date.now()
  };
  console.log(`📤 [PUSH] Master=${masterName} Trades=${req.body.trades||0} Eq=${req.body.equity||0}`);
  res.json({ok:true, master: masterName});
});

// Slave EA → GET /pull?id=VASANTHI&key=APIKEY
app.get('/pull', (req, res) => {
  const apiKey   = req.query.key || req.query.apiKey;
  const masterId = req.query.id  || req.query.masterId || req.query.masterID;
  if(!apiKey) return res.status(401).json({error:'API key required'});
  const client = verifyKey(apiKey);
  if(!client || !client.valid) return res.status(401).json({error:'Invalid or expired key'});

  const data = db.masterData[masterId];
  if(!data) {
    console.log(`📥 [PULL] Slave=${client.name} Master=${masterId} → No data yet`);
    return res.json({trades:0, positions:[], equity:0, empty:true});
  }

  // Check if master data is stale (>30 seconds)
  const age = Date.now() - (data.lastUpdate||0);
  if(age > 30000) {
    console.log(`📥 [PULL] Slave=${client.name} Master=${masterId} → Stale ${age}ms`);
    return res.json({trades:0, positions:[], equity:0, stale:true});
  }

  console.log(`📥 [PULL] Slave=${client.name} Master=${masterId} Trades=${data.trades||0}`);
  res.json(data);
});

// Generate key
app.get('/api/genkey', (req, res) => {
  const { admin, name, days, months, expiry } = req.query;
  if(admin !== ADMIN_PASS) return res.status(401).json({error:'Admin only'});
  if(!name) return res.status(400).json({error:'name required'});
  let dateStr='', mode='';
  if(days)        { dateStr=addDays(days);    mode=`${days} days`; }
  else if(months) { dateStr=addMonths(months); mode=`${months} months`; }
  else if(expiry) { dateStr=expiry; mode='custom'; }
  else return res.status(400).json({error:'Provide days, months, or expiry'});
  const clientName = name.toUpperCase();
  const key        = makeKey(clientName, dateStr);
  const expiryFmt  = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
  const left       = Math.ceil((new Date(expiryFmt)-new Date())/(1000*60*60*24));
  res.json({ key, client:clientName, expiry:expiryFmt, days_left:left, mode });
});

// Register Master
app.post('/api/master/register', authKey, async (req, res) => {
  const { mt5Login, mt5Password, mt5Server, broker } = req.body;
  if(!mt5Login || !mt5Password || !mt5Server)
    return res.status(400).json({error:'MT5 login, password, server required'});

  // Return existing
  const existing = Object.values(db.masters).find(m => m.mt5Login==mt5Login && m.apiKey==req.body.apiKey);
  if(existing) {
    return res.json({
      success:true, masterId:existing.id, name:existing.name,
      login:existing.mt5Login, server:existing.mt5Server,
      status:existing.status, expiry:req.client.expiry, daysLeft:req.client.daysLeft
    });
  }

  const id = uuidv4();
  db.masters[id] = {
    id, name:req.client.name, mt5Login, mt5Password, mt5Server,
    broker:broker||'Unknown', apiKey:req.body.apiKey,
    expiry:req.client.expiry, daysLeft:req.client.daysLeft,
    status:'connecting', metaAccountId:null
  };

  // Connect async
  connectMT5(mt5Login, mt5Password, mt5Server, `Master_${req.client.name}_${mt5Login}`)
    .then(account => {
      db.masters[id].metaAccountId = account.id;
      db.masters[id].status = 'connected';
      console.log(`✅ Master connected: ${req.client.name}`);
    })
    .catch(e => {
      db.masters[id].status = 'error';
      db.masters[id].error  = e.message;
      console.log(`❌ Master error: ${e.message}`);
    });

  res.json({
    success:true, masterId:id, name:req.client.name,
    login:mt5Login, server:mt5Server, status:'connecting',
    expiry:req.client.expiry, daysLeft:req.client.daysLeft
  });
});

// Register Slave
app.post('/api/slave/register', authKey, async (req, res) => {
  const { mt5Login, mt5Password, mt5Server, masterId, riskPercent } = req.body;
  if(!mt5Login || !mt5Password || !mt5Server || !masterId)
    return res.status(400).json({error:'All fields required'});

  const master = db.masters[masterId];
  if(!master) return res.status(404).json({error:'Master not found. Register master first!'});
  if(master.apiKey !== req.body.apiKey)
    return res.status(403).json({error:'API key mismatch'});

  const id = uuidv4();
  db.slaves[id] = {
    id, name:req.client.name, mt5Login, mt5Password, mt5Server,
    masterId, apiKey:req.body.apiKey, expiry:req.client.expiry,
    riskPercent:parseFloat(riskPercent)||1.0,
    status:'connecting', metaAccountId:null, copiedCount:0
  };

  // Connect + start copy engine async
  connectMT5(mt5Login, mt5Password, mt5Server, `Slave_${req.client.name}_${mt5Login}`)
    .then(account => {
      db.slaves[id].metaAccountId = account.id;
      db.slaves[id].status = 'connected';
      console.log(`✅ Slave connected: ${req.client.name}`);
      // Start copy engine after master is also connected
      const checkMaster = setInterval(() => {
        if(db.masters[masterId]?.status === 'connected') {
          clearInterval(checkMaster);
          startCopyEngine(id);
        } else if(db.masters[masterId]?.status === 'error') {
          clearInterval(checkMaster);
        }
      }, 3000);
    })
    .catch(e => {
      db.slaves[id].status = 'error';
      db.slaves[id].error  = e.message;
    });

  res.json({
    success:true, slaveId:id, name:req.client.name,
    login:mt5Login, masterId, riskPercent:db.slaves[id].riskPercent,
    status:'connecting', expiry:req.client.expiry
  });
});

// Status
app.get('/api/status', authKey, (req, res) => {
  const key      = req.query.apiKey;
  const myMasters = Object.values(db.masters).filter(m => m.apiKey===key);
  const mySlaves  = Object.values(db.slaves).filter(s => s.apiKey===key);
  res.json({
    client:req.client.name, expiry:req.client.expiry, daysLeft:req.client.daysLeft,
    masters: myMasters.map(m=>({id:m.id,login:m.mt5Login,server:m.mt5Server,status:m.status,error:m.error})),
    slaves:  mySlaves.map(s=>({id:s.id,login:s.mt5Login,server:s.mt5Server,masterId:s.masterId,riskPercent:s.riskPercent,status:s.status,copiedCount:s.copiedCount,error:s.error}))
  });
});

// Dashboard
app.get('/api/dashboard', (req, res) => {
  if(req.query.admin !== ADMIN_PASS) return res.status(401).json({error:'Admin only'});
  res.json({
    masters: Object.values(db.masters).map(m=>({name:m.name,login:m.mt5Login,server:m.mt5Server,status:m.status,expiry:m.expiry})),
    slaves:  Object.values(db.slaves).map(s=>({name:s.name,login:s.mt5Login,server:s.mt5Server,status:s.status,copiedCount:s.copiedCount,riskPercent:s.riskPercent})),
    total_masters:Object.keys(db.masters).length,
    total_slaves:Object.keys(db.slaves).length
  });
});

app.get('*', (req,res) => res.sendFile(path.join(__dirname,'public','index.html')));

const PORT = process.env.PORT || 8080;
loadMetaAPI().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ CopyTrader v6.0 | Port ${PORT}`);
    console.log(`🔑 Genkey: /api/genkey?admin=${ADMIN_PASS}&name=TEST&days=30`);
    console.log(`📊 Dashboard: /api/dashboard?admin=${ADMIN_PASS}`);
    console.log(`🔄 Own copy engine — No CopyFactory needed!`);
  });
});
