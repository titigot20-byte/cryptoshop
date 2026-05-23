const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

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

// ─── Données ──────────────────────────────────────────────────────────────────
const ADMIN = { user: 'admin', pass: 'admin123' };
const MIN_DEPOSIT = 20;

const users = {};
const products = [
  { id: 1, name: 'Pack Starter', price: 9.99,  img: 'https://placehold.co/200x140/111/fff?text=Starter' },
  { id: 2, name: 'Pack Pro',     price: 24.99, img: 'https://placehold.co/200x140/111/fff?text=Pro' },
];
const promos = {};

const isAdmin = (req) => req.headers['x-admin'] === ADMIN.pass;

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { pseudo, pass } = req.body;
  if (!pseudo || !pass) return res.json({ ok: false, msg: 'Champs requis' });
  if (users[pseudo]) return res.json({ ok: false, msg: 'Pseudo déjà pris' });
  users[pseudo] = { pass, balance: 0, pendingDeposit: 0 };
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  const { pseudo, pass } = req.body;
  if (pseudo === ADMIN.user && pass === ADMIN.pass)
    return res.json({ ok: true, role: 'admin' });
  const u = users[pseudo];
  if (!u || u.pass !== pass) return res.json({ ok: false, msg: 'Identifiants incorrects' });
  res.json({ ok: true, role: 'user', balance: u.balance });
});

// ─── Produits ─────────────────────────────────────────────────────────────────
app.get('/api/products', (_, res) => res.json(products));

app.post('/api/products', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { name, price, img } = req.body;
  if (!name || !price) return res.json({ ok: false, msg: 'Champs requis' });
  const p = { id: Date.now(), name, price: parseFloat(price), img: img || 'https://placehold.co/200x140/111/fff?text=Produit' };
  products.push(p);
  io.emit('products_update', products);
  res.json({ ok: true, product: p });
});

app.delete('/api/products/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const id = parseInt(req.params.id);
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: false });
  const img = products[idx].img;
  if (img.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(img));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  products.splice(idx, 1);
  io.emit('products_update', products);
  res.json({ ok: true });
});

app.post('/api/upload', upload.single('img'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  if (!req.file) return res.json({ ok: false, msg: 'Aucun fichier' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

// ─── Crypto ───────────────────────────────────────────────────────────────────
app.get('/api/crypto', (_, res) => res.json({
  BTC: 'bc1qtw4j5kxrtt7p2dvgr902xjm3539weejqzaug69',
  ETH: '0xd379734B31b9E497c6335ffe7C567fD45944bB41',
  SOL: 'FokaKh6BM6VargpzH5bXGKzGHmC9R2SFPhtiUAW79ypV',
}));

// ─── Dépôts ───────────────────────────────────────────────────────────────────
app.post('/api/deposit/request', (req, res) => {
  const { pseudo, amount } = req.body;
  const a = parseFloat(amount);
  if (!users[pseudo]) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (isNaN(a) || a < MIN_DEPOSIT) return res.json({ ok: false, msg: `Minimum ${MIN_DEPOSIT}€` });
  users[pseudo].pendingDeposit += a;
  res.json({ ok: true });
});

// ─── Promos ───────────────────────────────────────────────────────────────────
app.get('/api/promos', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  res.json(Object.entries(promos).map(([code, v]) => ({ code, ...v })));
});

app.post('/api/promos', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { code, discount, type, maxUses } = req.body;
  if (!code || !discount || !type) return res.json({ ok: false, msg: 'Champs requis' });
  const key = code.toUpperCase();
  if (promos[key]) return res.json({ ok: false, msg: 'Code déjà existant' });
  promos[key] = { discount: parseFloat(discount), type, uses: 0, maxUses: parseInt(maxUses) || 0 };
  res.json({ ok: true });
});

app.delete('/api/promos/:code', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  delete promos[req.params.code.toUpperCase()];
  res.json({ ok: true });
});

app.post('/api/promos/apply', (req, res) => {
  const { code, price } = req.body;
  const p = promos[code?.toUpperCase()];
  if (!p) return res.json({ ok: false, msg: 'Code invalide' });
  if (p.maxUses > 0 && p.uses >= p.maxUses) return res.json({ ok: false, msg: 'Code expiré' });
  const newPrice = p.type === 'percent'
    ? +(price * (1 - p.discount / 100)).toFixed(2)
    : +(price - p.discount).toFixed(2);
  p.uses++;
  res.json({ ok: true, newPrice: Math.max(0, newPrice), discount: p.discount, type: p.type });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  res.json(Object.entries(users).map(([pseudo, v]) => ({
    pseudo, balance: v.balance, pendingDeposit: v.pendingDeposit
  })));
});

app.get('/api/admin/pending', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const list = Object.entries(users)
    .filter(([, v]) => v.pendingDeposit > 0)
    .map(([pseudo, v]) => ({ pseudo, pending: v.pendingDeposit, balance: v.balance }));
  res.json(list);
});

app.post('/api/admin/validate', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { pseudo } = req.body;
  const u = users[pseudo];
  if (!u) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  u.balance += u.pendingDeposit;
  u.pendingDeposit = 0;
  res.json({ ok: true, newBalance: u.balance });
});

app.post('/api/admin/addbalance', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false });
  const { pseudo, amount } = req.body;
  const a = parseFloat(amount);
  if (!users[pseudo]) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (isNaN(a)) return res.json({ ok: false, msg: 'Montant invalide' });
  users[pseudo].balance += a;
  res.json({ ok: true, newBalance: users[pseudo].balance });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('chat_msg', ({ pseudo, text }) => {
    if (!text?.trim()) return;
    io.emit('chat_msg', { pseudo, text: text.slice(0, 300), ts: Date.now() });
  });
});

// ─── Fallback ─────────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));