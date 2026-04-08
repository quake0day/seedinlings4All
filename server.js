const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const mailer = (process.env.SMTP_HOST && process.env.SMTP_USER) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '465', 10),
  secure: (process.env.SMTP_SECURE || 'true') === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
}) : null;

function sendOrderEmail(order, items) {
  if (!mailer || !process.env.NOTIFY_EMAIL) return;
  const lines = items.map(it => `  • ${it.name_en} / ${it.name_zh} ${it.variety_en?`(${it.variety_en})`:''}  × ${it.qty}`).join('\n');
  const text = `New seedling order #${order.id}\n\nBuyer: ${order.buyer_name}\nContact: ${order.contact || '-'}\nNote: ${order.note || '-'}\nTime: ${new Date().toLocaleString()}\n\nItems:\n${lines}\n\nView: ${process.env.PUBLIC_URL || 'http://localhost:3000'}/admin`;
  mailer.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: process.env.NOTIFY_EMAIL,
    subject: `🌱 New order #${order.id} from ${order.buyer_name}`,
    text
  }).catch(e => console.error('Mail send failed:', e.message));
}

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';

const dataDir = path.join(__dirname, 'data');
const uploadDir = path.join(__dirname, 'uploads');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });

const db = new Database(path.join(dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS seedlings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en TEXT NOT NULL,
  name_zh TEXT NOT NULL,
  variety_en TEXT,
  variety_zh TEXT,
  description_en TEXT,
  description_zh TEXT,
  image TEXT,
  stock INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_name TEXT NOT NULL,
  contact TEXT,
  note TEXT,
  items_json TEXT NOT NULL,
  lang TEXT,
  created_at INTEGER NOT NULL
);
`);
// Migration: add token + view_password columns if missing
const cols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!cols.includes('token')) db.exec("ALTER TABLE orders ADD COLUMN token TEXT");
if (!cols.includes('view_password')) db.exec("ALTER TABLE orders ADD COLUMN view_password TEXT");

// Enrich items with current seedling names (so renames in admin propagate to orders)
function enrichItems(items) {
  const stmt = db.prepare('SELECT name_en, name_zh, variety_en, variety_zh, image FROM seedlings WHERE id=?');
  return items.map(it => {
    const cur = stmt.get(it.id);
    if (cur) return { ...it, name_en: cur.name_en, name_zh: cur.name_zh, variety_en: cur.variety_en, variety_zh: cur.variety_zh, image: cur.image };
    return it;
  });
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(uploadDir));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.\w]/g, '');
    cb(null, crypto.randomBytes(8).toString('hex') + ext);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function requireAdmin(req, res, next) {
  const pw = req.headers['x-admin-password'] || req.query.pw;
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// Public routes — serve same shop page, language detected on client from path
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/cn', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public')));

// Public: list seedlings
app.get('/api/seedlings', (req, res) => {
  const rows = db.prepare('SELECT * FROM seedlings ORDER BY id DESC').all();
  res.json(rows);
});

// Admin: create seedling
app.post('/api/admin/seedlings', requireAdmin, upload.single('image'), (req, res) => {
  const { name_en, name_zh, variety_en, variety_zh, description_en, description_zh, stock } = req.body;
  if (!name_en || !name_zh) return res.status(400).json({ error: 'name_en and name_zh required' });
  const image = req.file ? '/uploads/' + req.file.filename : (req.body.image_url || null);
  const info = db.prepare(
    `INSERT INTO seedlings (name_en, name_zh, variety_en, variety_zh, description_en, description_zh, image, stock, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(name_en, name_zh, variety_en||'', variety_zh||'', description_en||'', description_zh||'', image, parseInt(stock||'0',10), Date.now());
  res.json({ id: info.lastInsertRowid });
});

// Admin: update seedling
app.put('/api/admin/seedlings/:id', requireAdmin, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = db.prepare('SELECT * FROM seedlings WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const f = (k) => req.body[k] != null ? req.body[k] : cur[k];
  const stock = req.body.stock != null ? parseInt(req.body.stock, 10) : cur.stock;
  const image = req.file ? '/uploads/' + req.file.filename : (req.body.image_url || cur.image);
  db.prepare(`UPDATE seedlings SET name_en=?, name_zh=?, variety_en=?, variety_zh=?, description_en=?, description_zh=?, image=?, stock=? WHERE id=?`)
    .run(f('name_en'), f('name_zh'), f('variety_en'), f('variety_zh'), f('description_en'), f('description_zh'), image, stock, id);
  res.json({ ok: true });
});

app.delete('/api/admin/seedlings/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM seedlings WHERE id=?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

// Admin: fill out from a free-text blurb (any language) — Claude extracts + translates
app.post('/api/admin/fillout', requireAdmin, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'text required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const prompt = `You are helping fill a seedling product form. The user provided this free-form blurb (any language) about a plant variety:

"""
${text}
"""

Analyze it and return ONLY valid JSON, no markdown:
{
  "name_en": "common product name in English (e.g. 'Cherokee Purple Tomato')",
  "variety_en": "variety / cultivar info in English (e.g. 'Heirloom Indeterminate')",
  "description_en": "polished 2-4 sentence English description: taste, size, growing notes",
  "name_zh": "natural Chinese name",
  "variety_zh": "Chinese for variety_en",
  "description_zh": "fluent natural Chinese translation of description_en"
}

Infer reasonable values if the blurb is short. Always fill every field.`;
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(500).json({ error: 'Claude API error: ' + t.slice(0, 400) });
    }
    const aiJson = await aiRes.json();
    const txt = aiJson.content?.[0]?.text || '';
    const jm = txt.match(/\{[\s\S]*\}/);
    if (!jm) return res.status(500).json({ error: 'Could not parse JSON', raw: txt });
    res.json(JSON.parse(jm[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin: scrape a URL with Claude — extract + translate
app.post('/api/admin/scrape', requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set on server' });
  try {
    const browserHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Upgrade-Insecure-Requests': '1'
    };
    let r = await fetch(url, { headers: browserHeaders, redirect: 'follow' });
    let html;
    if (r.ok) {
      html = await r.text();
    } else {
      // Fallback: Jina Reader proxy (returns markdown + image links, bypasses most blocks)
      const jinaUrl = 'https://r.jina.ai/' + url;
      const r2 = await fetch(jinaUrl, { headers: { 'User-Agent': browserHeaders['User-Agent'] } });
      if (!r2.ok) return res.status(400).json({ error: `Fetch failed: direct=${r.status}, jina=${r2.status}` });
      html = await r2.text();
    }
    if (html.length > 200000) html = html.slice(0, 200000);

    const base = new URL(url);
    const imgs = [];
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og) { try { imgs.push(new URL(og[1], base).toString()); } catch {} }
    const mdImgRe = /!\[[^\]]*\]\(([^)\s]+)/g;
    let mm;
    while ((mm = mdImgRe.exec(html)) && imgs.length < 30) {
      try {
        const abs = new URL(mm[1], base).toString();
        if (/\.(jpe?g|png|webp)(\?|$)/i.test(abs) && !imgs.includes(abs)) imgs.push(abs);
      } catch {}
    }
    const imgRe = /<img[^>]+(?:src|data-src|data-original|data-lazy-src)=["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = imgRe.exec(html)) && imgs.length < 30) {
      try {
        const abs = new URL(m[1], base).toString();
        if (/\.(jpe?g|png|webp)(\?|$)/i.test(abs) && !imgs.includes(abs)) imgs.push(abs);
      } catch {}
    }

    const prompt = `You are extracting seedling/plant variety info from a webpage.

URL: ${url}

CANDIDATE IMAGE URLS (pick the single best one actually showing the plant or its produce):
${imgs.slice(0, 20).map((u,i)=>`${i+1}. ${u}`).join('\n') || '(none found)'}

PAGE HTML (truncated):
${html}

Return ONLY valid JSON, no markdown, no commentary:
{
  "name_en": "common product name in English (e.g. 'Cherokee Purple Tomato')",
  "variety_en": "variety / cultivar info in English (e.g. 'Heirloom Indeterminate')",
  "description_en": "2-4 sentence description in English: taste, size, growing notes",
  "name_zh": "natural Chinese name",
  "variety_zh": "Chinese translation of variety_en",
  "description_zh": "fluent Chinese translation of description_en",
  "image_url": "the single best image URL from the candidates above, or empty string"
}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(500).json({ error: 'Claude API error: ' + t.slice(0, 400) });
    }
    const aiJson = await aiRes.json();
    const text = aiJson.content?.[0]?.text || '';
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return res.status(500).json({ error: 'Could not parse JSON', raw: text });
    res.json(JSON.parse(jm[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Public: checkout
app.post('/api/checkout', (req, res) => {
  const { buyer_name, contact, note, items, lang } = req.body || {};
  if (!buyer_name || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: lang==='zh' ? '请填写姓名并选择菜苗' : 'Please enter your name and select seedlings' });
  }
  const tx = db.transaction(() => {
    const detailed = [];
    for (const it of items) {
      const id = parseInt(it.id, 10);
      const qty = parseInt(it.qty, 10);
      if (!id || !qty || qty < 1) throw new Error(lang==='zh'?'数量无效':'Invalid quantity');
      const row = db.prepare('SELECT * FROM seedlings WHERE id=?').get(id);
      if (!row) throw new Error(lang==='zh'?'菜苗不存在':'Seedling not found');
      if (row.stock < qty) {
        const nm = lang==='zh' ? row.name_zh : row.name_en;
        throw new Error(lang==='zh' ? `「${nm}」库存不足,仅剩 ${row.stock}` : `"${nm}" out of stock, only ${row.stock} left`);
      }
      db.prepare('UPDATE seedlings SET stock = stock - ? WHERE id=?').run(qty, id);
      detailed.push({ id, name_en: row.name_en, name_zh: row.name_zh, variety_en: row.variety_en, variety_zh: row.variety_zh, qty });
    }
    const token = crypto.randomBytes(12).toString('hex');
    const view_password = crypto.randomInt(100000, 1000000).toString();
    const info = db.prepare(
      'INSERT INTO orders (buyer_name, contact, note, items_json, lang, created_at, token, view_password) VALUES (?,?,?,?,?,?,?,?)'
    ).run(buyer_name, contact||'', note||'', JSON.stringify(detailed), lang||'en', Date.now(), token, view_password);
    return { id: info.lastInsertRowid, token, view_password };
  });
  try {
    const r = tx();
    sendOrderEmail({ id: r.id, buyer_name, contact, note }, items.map(it => {
      const row = db.prepare('SELECT name_en, name_zh, variety_en FROM seedlings WHERE id=?').get(it.id) || {};
      return { ...row, qty: it.qty };
    }));
    res.json({ ok: true, orderId: r.id, token: r.token, view_password: r.view_password });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  res.json(rows.map(r => ({ ...r, items: enrichItems(JSON.parse(r.items_json)) })));
});

// Public: look up your order with token + password
app.get('/api/order/:token', (req, res) => {
  const row = db.prepare('SELECT * FROM orders WHERE token=?').get(req.params.token);
  if (!row) return res.status(404).json({ error: 'Order not found' });
  if (req.query.pw !== row.view_password) return res.status(401).json({ error: 'Wrong password' });
  res.json({
    id: row.id,
    buyer_name: row.buyer_name,
    contact: row.contact,
    note: row.note,
    created_at: row.created_at,
    items: enrichItems(JSON.parse(row.items_json))
  });
});

app.get('/order', (_, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM orders WHERE id=?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Seedlings4All running on http://localhost:${PORT}`);
  console.log(`  English: http://localhost:${PORT}/`);
  console.log(`  中文:    http://localhost:${PORT}/cn`);
  console.log(`  Admin:   http://localhost:${PORT}/admin   (password: ${ADMIN_PASSWORD})`);
});
