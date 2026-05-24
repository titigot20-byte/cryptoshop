const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');

// ─── Setup ────────────────────────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

const DATA_FILE = path.join(__dirname, 'data.json');

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS_DIR),
  filename: (_, file, cb) => cb(null, Date.now() + path.extname(file.originalname)),
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(__dirname));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Persistance ──────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch(e) {}
  return {
    users: {},
    products: [
      { id: 1, name: 'Pack Starter', price: 9.99,  img: 'https://placehold.co/200x140/111/fff?text=Starter', stock: null },
      { id: 2, name: 'Pack Pro',     price: 24.99, img: 'https://placehold.co/200x140/111/fff?text=Pro',     stock: null },
    ],
    promos: {},
    orders: [],
  };
}

function save() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

let db = loadData();

// ─── Config admin ─────────────────────────────────────────────────────────────
const ADMIN_USER = process.env.ADMIN_USER || 'superadmin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Crypt0$h0p#2026!';

const MIN_DEPOSIT_USER     = 20;
const MIN_DEPOSIT_RESELLER = 50;
const RESELLER_DISCOUNT    = 0.10; // -10%

const CRYPTO = {
  BTC: 'bc1qtw4j5kxrtt7p2dvgr902xjm3539weejqzaug69',
  ETH: '0xd379734B31b9E497c6335ffe7C567fD45944bB41',
  SOL: 'FokaKh6BM6VargpzH5bXGKzGHmC9R2SFPhtiUAW79ypV',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const isAdmin = (req) => req.headers['x-admin'] === ADMIN_PASS;
const isReseller = (req) => {
  const pseudo = req.headers['x-pseudo'];
  const token  = req.headers['x-token'];
  const u = db.users[pseudo];
  return u && u.role === 'reseller' && u.apiToken === token;
};

function cryptoBonus(amount) {
  if (amount >= 100) return amount * 0.10;
  if (amount >= 50)  return amount * 0.05;
  return 0;
}

function resellerPrice(price) {
  return +(price * (1 - RESELLER_DISCOUNT)).toFixed(2);
}

function sanitize(str) {
  return String(str).replace(/[<>"'&]/g, '').trim().slice(0, 200);
}

function requireAdmin(req, res) {
  if (!isAdmin(req)) { res.status(403).json({ ok: false, msg: 'Non autorisé' }); return false; }
  return true;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const pseudo = sanitize(req.body.pseudo || '');
  const pass   = sanitize(req.body.pass   || '');
  if (!pseudo || !pass || pseudo.length < 3 || pass.length < 6)
    return res.json({ ok: false, msg: 'Pseudo (3+) et mot de passe (6+) requis' });
  if (db.users[pseudo]) return res.json({ ok: false, msg: 'Pseudo déjà pris' });
  db.users[pseudo] = { pass, balance: 0, pendingDeposit: 0, role: 'user', orders: [], apiToken: null, resellerSince: null };
  save();
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const pseudo = sanitize(req.body.pseudo || '');
  const pass   = sanitize(req.body.pass   || '');
  if (pseudo === ADMIN_USER && pass === ADMIN_PASS)
    return res.json({ ok: true, role: 'admin' });
  const u = db.users[pseudo];
  if (!u || u.pass !== pass) return res.json({ ok: false, msg: 'Identifiants incorrects' });
  res.json({ ok: true, role: u.role, balance: u.balance, apiToken: u.apiToken });
});

// ─── Produits ─────────────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const forReseller = isReseller(req);
  res.json(db.products.map(p => ({
    ...p,
    price: forReseller ? resellerPrice(p.price) : p.price,
  })));
});

app.post('/api/products', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const name  = sanitize(req.body.name  || '');
  const img   = sanitize(req.body.img   || 'https://placehold.co/200x140/111/fff?text=Produit');
  const price = parseFloat(req.body.price);
  const stock = req.body.stock !== undefined && req.body.stock !== '' ? parseInt(req.body.stock) : null;
  if (!name || isNaN(price)) return res.json({ ok: false, msg: 'Nom et prix requis' });
  const p = { id: Date.now(), name, price, img, stock };
  db.products.push(p);
  save();
  io.emit('products_update', publicProducts());
  res.json({ ok: true, product: p });
});

app.patch('/api/products/:id/stock', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = db.products.find(p => p.id === parseInt(req.params.id));
  if (!p) return res.json({ ok: false });
  p.stock = req.body.stock !== null && req.body.stock !== '' ? parseInt(req.body.stock) : null;
  save();
  io.emit('products_update', publicProducts());
  res.json({ ok: true });
});

app.delete('/api/products/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id  = parseInt(req.params.id);
  const idx = db.products.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: false });
  const img = db.products[idx].img;
  if (img.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(img));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.products.splice(idx, 1);
  save();
  io.emit('products_update', publicProducts());
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('img'), (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!req.file) return res.json({ ok: false, msg: 'Aucun fichier' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

function publicProducts() {
  return db.products.map(({ id, name, price, img, stock }) => ({ id, name, price, img, stock }));
}

// ─── Achats ───────────────────────────────────────────────────────────────────
app.post('/api/buy', (req, res) => {
  const pseudo = sanitize(req.body.pseudo || '');
  const pid    = parseInt(req.body.productId);
  const promo  = (req.body.promoCode || '').toUpperCase();
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  const p = db.products.find(p => p.id === pid);
  if (!p) return res.json({ ok: false, msg: 'Produit introuvable' });
  if (p.stock !== null && p.stock <= 0) return res.json({ ok: false, msg: 'Produit en rupture de stock' });

  let finalPrice = u.role === 'reseller' ? resellerPrice(p.price) : p.price;

  // Promo
  if (promo && db.promos[promo]) {
    const pr = db.promos[promo];
    if (pr.maxUses === 0 || pr.uses < pr.maxUses) {
      finalPrice = pr.type === 'percent'
        ? +(finalPrice * (1 - pr.discount / 100)).toFixed(2)
        : +(finalPrice - pr.discount).toFixed(2);
      finalPrice = Math.max(0, finalPrice);
      pr.uses++;
    }
  }

  if (u.balance < finalPrice) return res.json({ ok: false, msg: 'Solde insuffisant' });

  u.balance = +(u.balance - finalPrice).toFixed(2);
  if (p.stock !== null) p.stock--;

  const order = {
    id: Date.now(),
    pseudo,
    productId: p.id,
    productName: p.name,
    price: finalPrice,
    originalPrice: p.price,
    promo: promo || null,
    role: u.role,
    date: new Date().toISOString(),
  };
  db.orders.push(order);
  u.orders.push(order);
  save();
  io.emit('products_update', publicProducts());
  res.json({ ok: true, newBalance: u.balance, order });
});

// ─── Historique achats ────────────────────────────────────────────────────────
app.get('/api/orders/:pseudo', (req, res) => {
  const pseudo = sanitize(req.params.pseudo);
  const token  = req.headers['x-token'];
  const u = db.users[pseudo];
  if (!u) return res.status(403).json({ ok: false });
  // Admin ou le user lui-même ou revendeur avec son token
  if (!isAdmin(req) && !(u.apiToken && u.apiToken === token))
    return res.status(403).json({ ok: false });
  res.json(u.orders || []);
});

app.get('/api/admin/orders', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(db.orders);
});

// ─── Crypto / Dépôts ─────────────────────────────────────────────────────────
app.get('/api/crypto', (_, res) => res.json(CRYPTO));

app.post('/api/deposit/request', (req, res) => {
  const pseudo = sanitize(req.body.pseudo || '');
  const amount = parseFloat(req.body.amount);
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  const min = u.role === 'reseller' ? MIN_DEPOSIT_RESELLER : MIN_DEPOSIT_USER;
  if (isNaN(amount) || amount < min) return res.json({ ok: false, msg: `Minimum ${min}€` });
  const bonus = cryptoBonus(amount);
  u.pendingDeposit += amount;
  u.pendingBonus   = (u.pendingBonus || 0) + bonus;
  save();
  res.json({ ok: true, bonus });
});

// ─── Promos ───────────────────────────────────────────────────────────────────
app.get('/api/promos', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(Object.entries(db.promos).map(([code, v]) => ({ code, ...v })));
});

app.post('/api/promos', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const code    = sanitize(req.body.code || '').toUpperCase();
  const discount = parseFloat(req.body.discount);
  const type    = req.body.type === 'fixed' ? 'fixed' : 'percent';
  const maxUses = parseInt(req.body.maxUses) || 0;
  if (!code || isNaN(discount)) return res.json({ ok: false, msg: 'Champs requis' });
  if (db.promos[code]) return res.json({ ok: false, msg: 'Code déjà existant' });
  db.promos[code] = { discount, type, uses: 0, maxUses };
  save();
  res.json({ ok: true });
});

app.delete('/api/promos/:code', (req, res) => {
  if (!requireAdmin(req, res)) return;
  delete db.promos[req.params.code.toUpperCase()];
  save();
  res.json({ ok: true });
});

app.post('/api/promos/apply', (req, res) => {
  const code  = (req.body.code || '').toUpperCase();
  const price = parseFloat(req.body.price);
  const p = db.promos[code];
  if (!p) return res.json({ ok: false, msg: 'Code invalide' });
  if (p.maxUses > 0 && p.uses >= p.maxUses) return res.json({ ok: false, msg: 'Code expiré' });
  const newPrice = p.type === 'percent'
    ? +(price * (1 - p.discount / 100)).toFixed(2)
    : +(price - p.discount).toFixed(2);
  res.json({ ok: true, newPrice: Math.max(0, newPrice), discount: p.discount, type: p.type });
});

// ─── Admin : users ────────────────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(Object.entries(db.users).map(([pseudo, v]) => ({
    pseudo, balance: v.balance, pendingDeposit: v.pendingDeposit,
    pendingBonus: v.pendingBonus || 0, role: v.role, apiToken: v.apiToken,
  })));
});

app.get('/api/admin/pending', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(Object.entries(db.users)
    .filter(([, v]) => v.pendingDeposit > 0)
    .map(([pseudo, v]) => ({ pseudo, pending: v.pendingDeposit, bonus: v.pendingBonus || 0, balance: v.balance, role: v.role })));
});

app.post('/api/admin/validate', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pseudo = sanitize(req.body.pseudo || '');
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  u.balance = +(u.balance + u.pendingDeposit + (u.pendingBonus || 0)).toFixed(2);
  u.pendingDeposit = 0;
  u.pendingBonus   = 0;
  save();
  res.json({ ok: true, newBalance: u.balance });
});

app.post('/api/admin/addbalance', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pseudo = sanitize(req.body.pseudo || '');
  const amount = parseFloat(req.body.amount);
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (isNaN(amount)) return res.json({ ok: false, msg: 'Montant invalide' });
  u.balance = +(u.balance + amount).toFixed(2);
  save();
  res.json({ ok: true, newBalance: u.balance });
});

// ─── Admin : accès revendeur ──────────────────────────────────────────────────
app.post('/api/admin/promote', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pseudo = sanitize(req.body.pseudo || '');
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (u.role === 'reseller') return res.json({ ok: false, msg: 'Déjà revendeur' });
  u.role          = 'reseller';
  u.apiToken      = crypto.randomBytes(32).toString('hex');
  u.resellerSince = new Date().toISOString();
  save();
  res.json({ ok: true, apiToken: u.apiToken });
});

app.post('/api/admin/demote', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const pseudo = sanitize(req.body.pseudo || '');
  const u = db.users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  u.role     = 'user';
  u.apiToken = null;
  save();
  res.json({ ok: true });
});

// ─── API Revendeur (REST publique) ────────────────────────────────────────────
app.get('/api/reseller/products', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  res.json({ ok: true, products: db.products.map(p => ({ ...p, price: resellerPrice(p.price) })) });
});

app.post('/api/reseller/buy', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  const pseudo    = req.headers['x-pseudo'];
  const productId = parseInt(req.body.productId);
  req.body = { ...req.body, pseudo, productId };
  // Réutilise la route buy
  const u = db.users[pseudo];
  const p = db.products.find(p => p.id === productId);
  if (!u || !p) return res.json({ ok: false, msg: 'Produit ou utilisateur introuvable' });
  if (p.stock !== null && p.stock <= 0) return res.json({ ok: false, msg: 'Rupture de stock' });
  const finalPrice = resellerPrice(p.price);
  if (u.balance < finalPrice) return res.json({ ok: false, msg: 'Solde insuffisant' });
  u.balance = +(u.balance - finalPrice).toFixed(2);
  if (p.stock !== null) p.stock--;
  const order = { id: Date.now(), pseudo, productId: p.id, productName: p.name, price: finalPrice, originalPrice: p.price, role: 'reseller', date: new Date().toISOString() };
  db.orders.push(order);
  u.orders.push(order);
  save();
  res.json({ ok: true, order, newBalance: u.balance });
});

app.get('/api/reseller/balance', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  const u = db.users[req.headers['x-pseudo']];
  res.json({ ok: true, balance: u.balance });
});

app.get('/api/reseller/orders', (req, res) => {
  if (!isReseller(req)) return res.status(403).json({ ok: false, msg: 'Token invalide' });
  const u = db.users[req.headers['x-pseudo']];
  res.json({ ok: true, orders: u.orders || [] });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('chat_msg', ({ pseudo, text }) => {
    if (!text?.trim()) return;
    io.emit('chat_msg', { pseudo, text: String(text).replace(/[<>"]/g,'').slice(0, 300), ts: Date.now() });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));