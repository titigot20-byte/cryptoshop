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
app.use(express.static('.'));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── État ─────────────────────────────────────────────────────────────────────
const ADMIN = { user: 'admin', pass: 'admin123' };
const users = {};
const products = [
  { id: 1, name: 'Pack Starter', price: 9.99, img: 'https://placehold.co/200x140/111/fff?text=Starter' },
  { id: 2, name: 'Pack Pro',     price: 24.99, img: 'https://placehold.co/200x140/111/fff?text=Pro' },
];
const promos = {}; // { code: { discount, type: 'percent'|'fixed', uses, maxUses } }

const MIN_DEPOSIT = 20;

const adminCheck = (req, res) => {
  if (req.headers['x-admin'] !== ADMIN.pass) { res.status(403).end(); return false; }
  return true;
};

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
  const { name, price, img, adminPass } = req.body;
  if (adminPass !== ADMIN.pass) return res.status(403).json({ ok: false });
  const p = { id: Date.now(), name, price: parseFloat(price), img: img || 'https://placehold.co/200x140' };
  products.push(p);
  io.emit('products', products);
  res.json({ ok: true, product: p });
});

app.post('/api/upload', upload.single('img'), (req, res) => {
  if (!adminCheck(req, res)) return;
  if (!req.file) return res.json({ ok: false, msg: 'Aucun fichier' });
  res.json({ ok: true, url: `/uploads/${req.file.filename}` });
});

app.delete('/api/products/:id', (req, res) => {
  if (!adminCheck(req, res)) return;
  const id = parseInt(req.params.id);
  const idx = products.findIndex(p => p.id === id);
  if (idx === -1) return res.json({ ok: false });
  const img = products[idx].img;
  if (img.startsWith('/uploads/')) {
    const fp = path.join(UPLOADS_DIR, path.basename(img));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  products.splice(idx, 1);
  io.emit('products', products);
  res.json({ ok: true });
});

// ─── Promos ───────────────────────────────────────────────────────────────────
app.get('/api/promos', (req, res) => {
  if (!adminCheck(req, res)) return;
  res.json(Object.entries(promos).map(([code, v]) => ({ code, ...v })));
});

app.post('/api/promos', (req, res) => {
  if (!adminCheck(req, res)) return;
  const { code, discount, type, maxUses } = req.body;
  if (!code || !discount || !type) return res.json({ ok: false, msg: 'Champs requis' });
  if (promos[code.toUpperCase()]) return res.json({ ok: false, msg: 'Code déjà existant' });
  promos[code.toUpperCase()] = { discount: parseFloat(discount), type, uses: 0, maxUses: parseInt(maxUses) || 0 };
  res.json({ ok: true });
});

app.delete('/api/promos/:code', (req, res) => {
  if (!adminCheck(req, res)) return;
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

// ─── Dépôts ───────────────────────────────────────────────────────────────────
app.post('/api/deposit/request', (req, res) => {
  const { pseudo, amount } = req.body;
  const a = parseFloat(amount);
  if (!users[pseudo]) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (a < MIN_DEPOSIT) return res.json({ ok: false, msg: `Minimum ${MIN_DEPOSIT}€` });
  users[pseudo].pendingDeposit += a;
  res.json({ ok: true });
});

// ─── Admin : liste users ──────────────────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
  if (!adminCheck(req, res)) return;
  res.json(Object.entries(users).map(([pseudo, v]) => ({
    pseudo, balance: v.balance, pendingDeposit: v.pendingDeposit
  })));
});

app.get('/api/admin/pending', (req, res) => {
  if (!adminCheck(req, res)) return;
  const list = Object.entries(users)
    .filter(([, v]) => v.pendingDeposit > 0)
    .map(([pseudo, v]) => ({ pseudo, pending: v.pendingDeposit, balance: v.balance }));
  res.json(list);
});

app.post('/api/admin/validate', (req, res) => {
  const { pseudo, adminPass } = req.body;
  if (adminPass !== ADMIN.pass) return res.status(403).end();
  const u = users[pseudo];
  if (!u) return res.json({ ok: false });
  u.balance += u.pendingDeposit;
  u.pendingDeposit = 0;
  res.json({ ok: true, newBalance: u.balance });
});

// ─── Admin : ajout manuel de solde ───────────────────────────────────────────
app.post('/api/admin/addbalance', (req, res) => {
  if (!adminCheck(req, res)) return;
  const { pseudo, amount } = req.body;
  const a = parseFloat(amount);
  if (!users[pseudo]) return res.json({ ok: false, msg: 'Utilisateur inconnu' });
  if (isNaN(a)) return res.json({ ok: false, msg: 'Montant invalide' });
  users[pseudo].balance += a;
  res.json({ ok: true, newBalance: users[pseudo].balance });
});

// ─── Chat ─────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('msg', ({ pseudo, text }) => {
    if (!text?.trim()) return;
    io.emit('msg', { pseudo, text: text.slice(0, 300), ts: Date.now() });
  });
});

app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));