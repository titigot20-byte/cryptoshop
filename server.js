const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static('.'));

// ─── État en mémoire (remplace par une DB pour la prod) ───────────────────────
const ADMIN = { user: 'admin', pass: 'admin123' };
const users = {}; // { pseudo: { pass, balance, pendingDeposit } }
const products = [
  { id: 1, name: 'Pack Starter', price: 9.99, img: 'https://placehold.co/200x140/111/fff?text=Starter' },
  { id: 2, name: 'Pack Pro',     price: 24.99, img: 'https://placehold.co/200x140/111/fff?text=Pro' },
];

const CRYPTO = {
  BTC: 'bc1qtw4j5kxrtt7p2dvgr902xjm3539weejqzaug69',
  ETH: '0xd379734B31b9E497c6335ffe7C567fD45944bB41',
  SOL: 'FokaKh6BM6VargpzH5bXGKzGHmC9R2SFPhtiUAW79ypV',
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

// ─── Crypto / Dépôts ─────────────────────────────────────────────────────────
app.get('/api/crypto', (_, res) => res.json(CRYPTO));

app.post('/api/deposit/request', (req, res) => {
  const { pseudo, amount } = req.body;
  if (!users[pseudo]) return res.json({ ok: false });
  users[pseudo].pendingDeposit += parseFloat(amount);
  res.json({ ok: true });
});

// ─── Admin ────────────────────────────────────────────────────────────────────
app.get('/api/admin/pending', (req, res) => {
  if (req.headers['x-admin'] !== ADMIN.pass) return res.status(403).end();
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

// ─── Chat Socket.io ───────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.on('msg', ({ pseudo, text }) => {
    if (!text?.trim()) return;
    io.emit('msg', { pseudo, text: text.slice(0, 300), ts: Date.now() });
  });
});

// ─── Serve index ──────────────────────────────────────────────────────────────
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));