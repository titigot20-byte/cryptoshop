const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const multer   = require('multer');
const fs       = require('fs');
const crypto   = require('crypto');

// ─── Setup ────────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOADS_DIR),
    filename:    (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ─── Config ───────────────────────────────────────────────────────────────────
const ADMIN_USER           = process.env.ADMIN_USER  || 'superadmin';
const ADMIN_PASS           = process.env.ADMIN_PASS  || 'Crypt0$h0p#2026!';
const MIN_DEPOSIT_USER     = 20;
const MIN_DEPOSIT_RESELLER = 50;
const RESELLER_DISCOUNT    = 0.10;

const CRYPTO_ADDRESSES = {
  BTC: 'bc1qtw4j5kxrtt7p2dvgr902xjm3539weejqzaug69',
  ETH: '0xd379734B31b9E497c6335ffe7C567fD45944bB41',
  SOL: 'FokaKh6BM6VargpzH5bXGKzGHmC9R2SFPhtiUAW79ypV',
};

// ─── Persistance (fichier /tmp + fallback mémoire) ────────────────────────────
// Sur Render free tier, /tmp survit aux redémarrages chauds mais pas aux cold starts.
// On utilise donc UN fichier JSON dans /tmp ET on garde tout en mémoire.
// Les produits par défaut sont hardcodés pour ne jamais disparaître.

const DEFAULT_PRODUCTS = [
  { id: 1, name: 'Pack Starter', price: 9.99,  img: 'https://placehold.co/200x140/111/fff?text=Starter', stock: null },
  { id: 2, name: 'Pack Pro',     price: 24.99, img: 'https://placehold.co/200x140/111/fff?text=Pro',     stock: null },
];

const SAVE_FILE = '/tmp/cryptoshop_data.json';

function loadDB() {
  // 1. Essaie de charger depuis /tmp
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, 'utf8'));
      // Fusionne les produits par défaut avec ceux sauvegardés
      const savedIds = new Set(raw.products.map(p => p.id));
      DEFAULT_PRODUCTS.forEach(dp => { if (!savedIds.has(dp.id)) raw.products.unshift(dp); });
      console.log('✅ DB chargée depuis /tmp');
      return raw;
    }
  } catch(e) { console.log('⚠️ Impossible de charger /tmp, DB vierge'); }

  return {
    users:    {},
    products: JSON.parse(JSON.stringify(DEFAULT_PRODUCTS)),
    promos:   {},
    orders:   [],
  };
}

let db = loadDB();

// Sauvegarde dans /tmp
function save() {
  try { fs.writeFileSync(SAVE_FILE, JSON.stringify(db)); }
  catch(e) { console.error('Save error:', e.message); }
}

// Auto-save toutes les 30 secondes
setInterval(save, 30000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAdmin    = (req) => req.headers['x-admin'] === ADMIN_PASS;
const isReseller = (req) => {
  const u = db.users[req.headers['x-pseudo']];
  return u && u.role === 'reseller' && u.apiToken === req.headers['x-token'];
};
const ok403 = (req, res) => { if (!isAdmin(req)) { res.status(403).json({ ok: false, msg: 'Non autorisé' }); return false; } return true; };
const san   = (s) => String(s || '').replace(/[<>"']/g, '').trim().slice(0, 300);
const rprice = (p) => +(p * (1 - RESELLER_DISCOUNT)).toFixed(2);
const bonus  = (amt) => amt >= 100 ? +(amt * 0.10).toFixed(2) : amt >= 50 ? +(amt * 0.05).toFixed(2) : 0;

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const pseudo = san(req.body.pseudo), pass = san(req.body.pass);
  if (!pseudo || !pass || pseudo.length < 3 || pass.length < 6)
    return res.json({ ok: false, msg: 'Pseudo ≥3 chars, mot de passe ≥6 chars' });
  if (db.users[pseudo]) return res.json({ ok: false, msg: 'Pseudo déjà pris' });
  db.users[pseudo] = { pass, balance: 0, pendingDeposit: 0, pendingBonus: 0, role: 'user', orders: [], apiToken: null };
  save();
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const pseudo = san(req.body.pseudo), pass = san(req.body.pass);
  if (pseudo === ADMIN_USER && pass === ADMIN_PASS)
    return res.json({ ok: true, role: 'admin' });
  const u = db.users[pseudo];
  if (!u || u.pass !== pass) return res.json({ ok: false, msg: 'Identifiants incorrects' });
  res.json({ ok: true, role: u.role, balance: u.balance, apiToken: u.apiToken || null });
});

// ─── Produits ─────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const rev = isReseller(req);
  res.json(db.products.map(p => ({ ...p, price: rev ? rprice(p.price) : p.price })));
});

// Ajout d'UN produit
app.post('/api/products', (req, res) => {
  if (!ok403(req, res)) return;
  const name  = san(req.body.name);
  const price = parseFloat(req.body.price);
  const img   = san(req.body.img) || 'https://placehold.co/200x140/111/fff?text=Produit';
  const stock = (req.body.stock !== '' && req.body.stock != null) ? parseInt(req.body.stock) : null;
  if (!name || isNaN(price)) return res.json({ ok: false, msg: 'Nom et prix requis' });
  const p = { id: Date.now(), name, price, img, stock };
  db.products.push(p);
  save();
  io.emit('products_update', db.products);
  res.json({ ok: true, product: p });
});

// Ajout en masse
app.post('/api/products/bulk', (req, res) => {
  if (!ok403(req, res)) return;
  const items = req.body.items;
  if (!Array.isArray(items) || !items.length) return res.json({ ok: false, msg: 'Liste vide' });
  const added = [];
  for (const item of items) {
    const name  = san(item.name);
    const price = parseFloat(item.price);
    if (!name || isNaN(price)) continue;
    const p = {
      id:    Date.now() + Math.random(),
      name,
      price,
      img:   san(item.img) || 'https://placehold.co/200x140/111/fff?text=' + encodeURIComponent(name),
      stock: (item.stock !== '' && item.stock != null) ? parseInt(item.stock) : null,
    };
    db.products.push(p);
    added.push(p);
  }
  save();
  io.emit('products_update', db.products);
  res.json({ ok: true, added: added.length });
});

app.patch('/api/products/:id/stock', (req, res) => {
  if (!ok403(req, res)) return;
  const p = db.products.find(p => p.id == req.params.id);
  if (!p) return res.json({ ok: false });
  p.stock = (req.body.stock !== '' && req.body.stock != null) ? parseInt(req.body.stock) : null;
  save();
  io.emit('products_update', db.products);
  res.json({ ok: true });
});

app.delete('/api/products/:id', (req, res) => {
  if (!ok403(req, res)) return;
  const idx = db.products.findIndex(p => p.id == req.params.id);
  if (idx === -1) return res.json({ ok: false });
  const img = db.products[idx].img;
  if (img.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(img));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.products.splice(idx, 1);
  save();
  io.emit('products_update', db.products);
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('img'), (req, res) => {
  if (!ok403(req, res)) return;
  if (!req.file) return res.json({ ok: false, msg: 'Aucun fichier' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

// ─── Achats ───────────────────────────────────────────────────────────────────
app.post('/api/buy', (req, res) => {
  const pseudo = san(req.body.pseudo);
  const pid    = req.body.productId;
  const promo  = san(req.body.promoCode || '').toUpperCase();
  const u = db.users[pseudo];
  const p = db.products.find(p => p.id == pid);
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (!p) return res.json({ ok: false, msg: 'Produit introuvable' });
  if (p.stock !== null && p.stock <= 0) return res.json({ ok: false, msg: 'Rupture de stock' });
  let fp = u.role === 'reseller' ? rprice(p.price) : p.price;
  if (promo && db.promos[promo]) {
    const pr = db.promos[promo];
    if (!pr.maxUses || pr.uses < pr.maxUses) {
      fp = pr.type === 'percent' ? +(fp * (1 - pr.discount / 100)).toFixed(2) : +(fp - pr.discount).toFixed(2);
      fp = Math.max(0, fp);
      pr.uses++;
    }
  }
  if (u.balance < fp) return res.json({ ok: false, msg: 'Solde insuffisant' });
  u.balance = +(u.balance - fp).toFixed(2);
  if (p.stock !== null) p.stock--;
  const order = { id: Date.now(), pseudo, productId: p.id, productName: p.name, price: fp, originalPrice: p.price, promo: promo || null, role: u.role, date: new Date().toISOString() };
  db.orders.push(order);
  if (!u.orders) u.orders = [];
  u.orders.push(order);
  save();
  io.emit('products_update', db.products);
  res.json({ ok: true, newBalance: u.balance, order });
});

// ─── Commandes ────────────────────────────────────────────────────────────────
app.get('/api/orders/:pseudo', (req, res) => {
  const pseudo = san(req.params.pseudo);
  const u = db.users[pseudo];
  if (!u) return res.status(403).json({ ok: false });
  if (!isAdmin(req) && !(u.apiToken && u.apiToken === req.headers['x-token']))
    return res.status(403).json({ ok: false });
  res.json(u.orders || []);
});

app.get('/api/admin/orders', (req, res) => {
  if (!ok403(req, res)) return;
  res.json(db.orders);
});

// ─── Crypto ───────────────────────────────────────────────────────────────────
app.get('/api/crypto', (_, res) => res.json(CRYPTO_ADDRESSES));

app.post('/api/deposit/request', (req, res) => {
  const pseudo = san(req.body.pseudo);
  const amount = parseFloat(req.body.amount);
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  const min = u.role === 'reseller' ? MIN_DEPOSIT_RESELLER : MIN_DEPOSIT_USER;
  if (isNaN(amount) || amount < min) return res.json({ ok: false, msg: `Minimum ${min}€` });
  const b = bonus(amount);
  u.pendingDeposit += amount;
  u.pendingBonus    = +(( u.pendingBonus || 0) + b).toFixed(2);
  save();
  res.json({ ok: true, bonus: b });
});

// ─── Promos ───────────────────────────────────────────────────────────────────
app.get('/api/promos', (req, res) => {
  if (!ok403(req, res)) return;
  res.json(Object.entries(db.promos).map(([code, v]) => ({ code, ...v })));
});
app.post('/api/promos', (req, res) => {
  if (!ok403(req, res)) return;
  const code = san(req.body.code).toUpperCase();
  const discount = parseFloat(req.body.discount);
  if (!code || isNaN(discount)) return res.json({ ok: false, msg: 'Champs requis' });
  if (db.promos[code]) return res.json({ ok: false, msg: 'Code déjà existant' });
  db.promos[code] = { discount, type: req.body.type === 'fixed' ? 'fixed' : 'percent', uses: 0, maxUses: parseInt(req.body.maxUses) || 0 };
  save();
  res.json({ ok: true });
});
app.delete('/api/promos/:code', (req, res) => {
  if (!ok403(req, res)) return;
  delete db.promos[req.params.code.toUpperCase()];
  save();
  res.json({ ok: true });
});
app.post('/api/promos/apply', (req, res) => {
  const p = db.promos[(req.body.code || '').toUpperCase()];
  if (!p) return res.json({ ok: false, msg: 'Code invalide' });
  if (p.maxUses > 0 && p.uses >= p.maxUses) return res.json({ ok: false, msg: 'Code expiré' });
  const np = p.type === 'percent'
    ? +(req.body.price * (1 - p.discount / 100)).toFixed(2)
    : +(req.body.price - p.discount).toFixed(2);
  res.json({ ok: true, newPrice: Math.max(0, np), discount: p.discount, type: p.type });
});

// ─── Admin users ──────────────────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  if (!ok403(req, res)) return;
  res.json(Object.entries(db.users).map(([pseudo, v]) => ({
    pseudo, balance: v.balance, pendingDeposit: v.pendingDeposit,
    pendingBonus: v.pendingBonus || 0, role: v.role, apiToken: v.apiToken,
  })));
});
app.get('/api/admin/pending', (req, res) => {
  if (!ok403(req, res)) return;
  res.json(Object.entries(db.users)
    .filter(([,v]) => v.pendingDeposit > 0)
    .map(([pseudo, v]) => ({ pseudo, pending: v.pendingDeposit, bonus: v.pendingBonus || 0, balance: v.balance, role: v.role })));
});
app.post('/api/admin/validate', (req, res) => {
  if (!ok403(req, res)) return;
  const u = db.users[san(req.body.pseudo)];
  if (!u) return res.json({ ok: false, msg: 'Introuvable' });
  u.balance = +(u.balance + u.pendingDeposit + (u.pendingBonus || 0)).toFixed(2);
  u.pendingDeposit = 0; u.pendingBonus = 0;
  save();
  res.json({ ok: true, newBalance: u.balance });
});
app.post('/api/admin/addbalance', (req, res) => {
  if (!ok403(req, res)) return;
  const u = db.users[san(req.body.pseudo)];
  if (!u) return res.json({ ok: false, msg: 'Introuvable' });
  u.balance = +(u.balance + parseFloat(req.body.amount)).toFixed(2);
  save();
  res.json({ ok: true, newBalance: u.balance });
});
app.post('/api/admin/promote', (req, res) => {
  if (!ok403(req, res)) return;
  const u = db.users[san(req.body.pseudo)];
  if (!u) return res.json({ ok: false, msg: 'Introuvable' });
  u.role = 'reseller';
  u.apiToken = crypto.randomBytes(32).toString('hex');
  save();
  res.json({ ok: true, apiToken: u.apiToken });
});
app.post('/api/admin/demote', (req, res) => {
  if (!ok403(req, res)) return;
  const u = db.users[san(req.body.pseudo)];
  if (!u) return res.json({ ok: false, msg: 'Introuvable' });
  u.role = 'user'; u.apiToken = null;
  save();
  res.json({ ok: true });
});

// ─── API Revendeur ────────────────────────────────────────────────────────────
app.get('/api/reseller/products', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  res.json({ ok: true, products: db.products.map(p => ({ ...p, price: rprice(p.price) })) });
});
app.post('/api/reseller/buy', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  const pseudo = req.headers['x-pseudo'];
  req.body.pseudo = pseudo;
  const u = db.users[pseudo];
  const p = db.products.find(p => p.id == req.body.productId);
  if (!u || !p) return res.json({ ok: false, msg: 'Introuvable' });
  if (p.stock !== null && p.stock <= 0) return res.json({ ok: false, msg: 'Rupture de stock' });
  const fp = rprice(p.price);
  if (u.balance < fp) return res.json({ ok: false, msg: 'Solde insuffisant' });
  u.balance = +(u.balance - fp).toFixed(2);
  if (p.stock !== null) p.stock--;
  const order = { id: Date.now(), pseudo, productId: p.id, productName: p.name, price: fp, originalPrice: p.price, role: 'reseller', date: new Date().toISOString() };
  db.orders.push(order);
  if (!u.orders) u.orders = [];
  u.orders.push(order);
  save();
  res.json({ ok: true, order, newBalance: u.balance });
});
app.get('/api/reseller/balance', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  res.json({ ok: true, balance: db.users[req.headers['x-pseudo']].balance });
});
app.get('/api/reseller/orders', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  res.json({ ok: true, orders: db.users[req.headers['x-pseudo']].orders || [] });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('chat_msg', ({ pseudo, text }) => {
    if (!text?.trim()) return;
    io.emit('chat_msg', { pseudo: san(pseudo), text: san(text).slice(0, 300), ts: Date.now() });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));