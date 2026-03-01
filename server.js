// ============================================================
//  CopyTrader Web  — Full Stack Server
//  MetaAPI based — No EA needed!
//  Client just enters MT5 details on website
// ============================================================

const express    = require('express');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const crypto     = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Frontend files

// ============================================================
//  CONFIG — Change these!
// ============================================================
const METAAPI_TOKEN = process.env.METAAPI_TOKEN || "YOUR_METAAPI_TOKEN";
const SECRET        = process.env.SECRET        || "JEEVAN_SECRET_2026";
const ADMIN_PASS    = process.env.ADMIN_PASS    || "JEEVAN";
// ============================================================

// In-memory DB (Railway restart = data loss)
// Production lo MongoDB use cheyyachu
const db = {
  masters: {},  // { id: { name, mt5Login, mt5Pass, mt5Server, broker, apiKey, expiry, metaAccountId, status } }
  slaves:  {},  // { id: { name, mt5Login, mt5Pass, mt5Server, masterId, apiKey, expiry, metaAccountId, riskPercent, status } }
  copies:  {}   // { slaveId: { masterSlaveId (metaapi copy id) } }
};

// ── MetaAPI helpers ──────────────────────────────────────────
let MetaApi, CopyFactory;
async function loadMetaAPI() {
  try {
    const sdk = require('metaapi.cloud-sdk');
    MetaApi     = sdk.default || sdk.MetaApi;
    CopyFactory = sdk.CopyFactory;
    console.log('✅ MetaAPI SDK loaded');
  } catch(e) {
    console.log('⚠️ MetaAPI SDK not loaded:', e.message);
  }
}

// ── Signature for keys ───────────────────────────────────────
function generateSig(name, dateStr) {
  const hash = crypto.createHash('sha256').update(`${name}_${dateStr}_${SECRET}`).digest('hex');
  return hash.substring(0,4).toUpperCase();
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
  const sig = generateSig(name, dateStr);
  return `${name}_${dateStr}_${sig}`;
}
function verifyKey(key) {
  const parts = key.split('_');
  if(parts.length < 3) return null;
  const sig    = parts[parts.length-1];
  const date   = parts[parts.length-2];
  const name   = parts.slice(0,parts.length-2).join('_');
  if(!/^\d{8}$/.test(date)) return null;
  if(generateSig(name,date) !== sig.toUpperCase()) return null;
  const expiry = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`;
  const today  = new Date().toISOString().split('T')[0];
  const daysLeft = Math.ceil((new Date(expiry)-new Date())/(1000*60*60*24));
  return { name, expiry, daysLeft, valid: today <= expiry };
}

// ── Auth middleware ──────────────────────────────────────────
function authKey(req, res, next) {
  const key = req.body.apiKey || req.query.apiKey;
  if(!key) return res.status(401).json({error:'API key required'});
  const client = verifyKey(key);
  if(!client) return res.status(401).json({error:'Invalid API key'});
  if(!client.valid) return res.status(403).json({error:'License expired! Contact admin.', expiry: client.expiry});
  req.client = client;
  next();
}

// ============================================================
//  API ROUTES
// ============================================================

// ── Generate License Key ─────────────────────────────────────
// /api/genkey?admin=JEEVAN&name=USHA&days=30
app.get('/api/genkey', (req, res) => {
  const { admin, name, days, months, expiry } = req.query;
  if(admin !== ADMIN_PASS) return res.status(401).json({error:'Admin only'});
  if(!name) return res.status(400).json({error:'name required'});

  let dateStr = '';
  let mode = '';
  if(days)        { dateStr = addDays(days);    mode = `${days} days`; }
  else if(months) { dateStr = addMonths(months); mode = `${months} months`; }
  else if(expiry) { dateStr = expiry; mode = 'custom date'; }
  else return res.status(400).json({error:'Provide days, months, or expiry(YYYYMMDD)'});

  const clientName = name.toUpperCase();
  const key        = makeKey(clientName, dateStr);
  const expiryFmt  = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
  const left       = Math.ceil((new Date(expiryFmt)-new Date())/(1000*60*60*24));

  res.json({ key, client: clientName, expiry: expiryFmt, days_left: left, mode });
});

// ── Register Master Account ──────────────────────────────────
app.post('/api/master/register', authKey, async (req, res) => {
  const { mt5Login, mt5Password, mt5Server, broker, riskPercent } = req.body;
  const apiKey = req.body.apiKey;

  if(!mt5Login || !mt5Password || !mt5Server)
    return res.status(400).json({error:'MT5 login, password, server required'});

  // Check duplicate — update existing
  const existing = Object.values(db.masters).find(m => m.mt5Login == mt5Login);
  if(existing) {
    // Return existing master ID
    return res.json({
      success:  true,
      masterId: existing.id,
      name:     existing.name,
      login:    existing.mt5Login,
      server:   existing.mt5Server,
      status:   existing.status,
      expiry:   req.client.expiry,
      daysLeft: req.client.daysLeft
    });
  }

  const id = uuidv4();
  db.masters[id] = {
    id,
    name:       req.client.name,
    mt5Login,
    mt5Password,
    mt5Server,
    broker:     broker || 'Unknown',
    apiKey,
    expiry:     req.client.expiry,
    daysLeft:   req.client.daysLeft,
    riskPercent: riskPercent || 1.0,
    status:     'connecting',
    metaAccountId: null,
    createdAt:  new Date().toISOString()
  };

  // Connect to MetaAPI
  try {
    if(MetaApi && METAAPI_TOKEN !== 'YOUR_METAAPI_TOKEN' && METAAPI_TOKEN !== 'placeholder') {
      const api         = new MetaApi(METAAPI_TOKEN);
      const account     = await api.metatraderAccountApi.createAccount({
        name:           `Master_${req.client.name}_${mt5Login}`,
        type:           'cloud',
        login:          mt5Login.toString(),
        password:       mt5Password,
        server:         mt5Server,
        platform:       'mt5',
        magic:          1000
      });
      db.masters[id].metaAccountId = account.id;
      await account.deploy();
      await account.waitConnected();
      db.masters[id].status = 'connected';
      console.log(`✅ Master connected: ${req.client.name} | Login=${mt5Login}`);
    } else {
      db.masters[id].status = 'active';
      console.log(`🔵 Master registered: ${req.client.name} | Login=${mt5Login}`);
    }
  } catch(e) {
    db.masters[id].status = 'active'; // Still return success with ID
    db.masters[id].error  = e.message;
    console.log(`⚠️ MetaAPI error (non-fatal): ${e.message}`);
  }

  res.json({
    success:  true,
    masterId: id,
    name:     req.client.name,
    login:    mt5Login,
    server:   mt5Server,
    status:   db.masters[id].status,
    expiry:   req.client.expiry,
    daysLeft: req.client.daysLeft
  });
});

// ── Register Slave Account ───────────────────────────────────
app.post('/api/slave/register', authKey, async (req, res) => {
  const { mt5Login, mt5Password, mt5Server, masterId, riskPercent } = req.body;

  if(!mt5Login || !mt5Password || !mt5Server || !masterId)
    return res.status(400).json({error:'MT5 details + masterId required'});

  const master = db.masters[masterId];
  if(!master) return res.status(404).json({error:'Master not found'});

  // Key must match master's key (security)
  if(master.apiKey !== req.body.apiKey)
    return res.status(403).json({error:'API key does not match master account'});

  const id = uuidv4();
  db.slaves[id] = {
    id,
    name:        req.client.name,
    mt5Login,
    mt5Password,
    mt5Server,
    masterId,
    apiKey:      req.body.apiKey,
    expiry:      req.client.expiry,
    daysLeft:    req.client.daysLeft,
    riskPercent: parseFloat(riskPercent) || 1.0,
    status:      'connecting',
    metaAccountId: null,
    createdAt:   new Date().toISOString()
  };

  // Connect slave to MetaAPI + start copy
  try {
    if(MetaApi && CopyFactory && METAAPI_TOKEN !== 'YOUR_METAAPI_TOKEN' && METAAPI_TOKEN !== 'placeholder') {
      const api      = new MetaApi(METAAPI_TOKEN);
      const cf       = new CopyFactory(METAAPI_TOKEN);
      const account  = await api.metatraderAccountApi.createAccount({
        name:     `Slave_${req.client.name}_${mt5Login}`,
        type:     'cloud',
        login:    mt5Login.toString(),
        password: mt5Password,
        server:   mt5Server,
        platform: 'mt5',
        magic:    2000
      });
      db.slaves[id].metaAccountId = account.id;
      await account.deploy();
      await account.waitConnected();
      const configApi   = cf.configurationApi;
      const masterAccount = db.masters[masterId];
      await configApi.updateStrategy(masterAccount.metaAccountId, {
        name:        `Strategy_${masterAccount.name}`,
        description: `Copy strategy for ${masterAccount.name}`
      });
      await configApi.updateSubscriber(account.id, {
        strategy: { id: masterAccount.metaAccountId },
        multiplier: parseFloat(riskPercent) || 1.0,
        skipPendingOrders: false
      });
      db.slaves[id].status = 'copying';
      console.log(`✅ Slave connected & copying: ${req.client.name}`);
    } else {
      db.slaves[id].status = 'active';
      console.log(`🔵 Slave registered: ${req.client.name} | Login=${mt5Login}`);
    }
  } catch(e) {
    db.slaves[id].status = 'active';
    db.slaves[id].error  = e.message;
    console.log(`⚠️ Slave MetaAPI error (non-fatal): ${e.message}`);
  }

  res.json({
    success:  true,
    slaveId:  id,
    name:     req.client.name,
    login:    mt5Login,
    masterId,
    riskPercent: db.slaves[id].riskPercent,
    status:   db.slaves[id].status,
    expiry:   req.client.expiry
  });
});

// ── Status check ─────────────────────────────────────────────
app.get('/api/status', authKey, (req, res) => {
  const myMasters = Object.values(db.masters).filter(m => m.apiKey === req.body.apiKey || m.apiKey === req.query.apiKey);
  const mySlaves  = Object.values(db.slaves).filter(s => s.apiKey === req.body.apiKey || s.apiKey === req.query.apiKey);
  res.json({
    client:   req.client.name,
    expiry:   req.client.expiry,
    daysLeft: req.client.daysLeft,
    masters:  myMasters.map(m => ({ id:m.id, login:m.mt5Login, server:m.mt5Server, status:m.status })),
    slaves:   mySlaves.map(s => ({ id:s.id, login:s.mt5Login, server:s.mt5Server, masterId:s.masterId, riskPercent:s.riskPercent, status:s.status }))
  });
});

// ── Dashboard ─────────────────────────────────────────────────
app.get('/api/dashboard', (req, res) => {
  if(req.query.admin !== ADMIN_PASS) return res.status(401).json({error:'Admin only'});
  res.json({
    masters: Object.values(db.masters).map(m=>({name:m.name,login:m.mt5Login,server:m.mt5Server,status:m.status,expiry:m.expiry})),
    slaves:  Object.values(db.slaves).map(s=>({name:s.name,login:s.mt5Login,server:s.mt5Server,status:s.status,riskPercent:s.riskPercent})),
    total_masters: Object.keys(db.masters).length,
    total_slaves:  Object.keys(db.slaves).length
  });
});

// ── Serve frontend ────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
loadMetaAPI().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ CopyTrader Web Server | Port ${PORT}`);
    console.log(`🔑 Genkey: /api/genkey?admin=${ADMIN_PASS}&name=USHA&days=30`);
    console.log(`📊 Dashboard: /api/dashboard?admin=${ADMIN_PASS}`);
  });
});
