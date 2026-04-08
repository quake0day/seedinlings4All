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
  const base = process.env.PUBLIC_URL || 'http://localhost:3000';
  const customerLink = `${base}/order?t=${order.token}&pw=${order.view_password}`;
  const lines = items.map(it => `  • ${it.name_en} / ${it.name_zh} ${it.variety_en?`(${it.variety_en})`:''}  × ${it.qty}`).join('\n');
  const text = `New seedling order #${order.id}\n\nBuyer: ${order.buyer_name}\nContact: ${order.contact || '-'}\nNote: ${order.note || '-'}\nTime: ${new Date().toLocaleString()}\n\nItems:\n${lines}\n\nCustomer order link (one-click view):\n${customerLink}\n\nAdmin: ${base}/admin`;
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
// Migrations
const ocols = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!ocols.includes('token')) db.exec("ALTER TABLE orders ADD COLUMN token TEXT");
if (!ocols.includes('view_password')) db.exec("ALTER TABLE orders ADD COLUMN view_password TEXT");
const scols = db.prepare("PRAGMA table_info(seedlings)").all().map(c => c.name);
if (!scols.includes('category'))      db.exec("ALTER TABLE seedlings ADD COLUMN category TEXT DEFAULT ''");
if (!scols.includes('active'))        db.exec("ALTER TABLE seedlings ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
if (!scols.includes('sort_order'))    db.exec("ALTER TABLE seedlings ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
if (!scols.includes('care_tips_en'))  db.exec("ALTER TABLE seedlings ADD COLUMN care_tips_en TEXT DEFAULT ''");
if (!scols.includes('care_tips_zh'))  db.exec("ALTER TABLE seedlings ADD COLUMN care_tips_zh TEXT DEFAULT ''");

// Enrich items with current seedling names (so renames in admin propagate to orders)
function enrichItems(items) {
  const stmt = db.prepare('SELECT name_en, name_zh, variety_en, variety_zh, image, care_tips_en, care_tips_zh FROM seedlings WHERE id=?');
  return items.map(it => {
    const cur = stmt.get(it.id);
    if (cur) return { ...it, name_en: cur.name_en, name_zh: cur.name_zh, variety_en: cur.variety_en, variety_zh: cur.variety_zh, image: cur.image, care_tips_en: cur.care_tips_en, care_tips_zh: cur.care_tips_zh };
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

// Public: list active seedlings (ordered by sort_order, then id)
app.get('/api/seedlings', (req, res) => {
  const rows = db.prepare('SELECT * FROM seedlings WHERE active=1 ORDER BY sort_order ASC, id DESC').all();
  res.json(rows);
});

// Admin: list ALL seedlings (incl. inactive)
app.get('/api/admin/seedlings', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM seedlings ORDER BY sort_order ASC, id DESC').all();
  res.json(rows);
});

// Admin: create seedling
app.post('/api/admin/seedlings', requireAdmin, upload.single('image'), (req, res) => {
  const b = req.body;
  if (!b.name_en || !b.name_zh) return res.status(400).json({ error: 'name_en and name_zh required' });
  const image = req.file ? '/uploads/' + req.file.filename : (b.image_url || null);
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order),0) AS m FROM seedlings').get().m;
  const info = db.prepare(
    `INSERT INTO seedlings (name_en, name_zh, variety_en, variety_zh, description_en, description_zh, image, stock, category, active, sort_order, care_tips_en, care_tips_zh, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(b.name_en, b.name_zh, b.variety_en||'', b.variety_zh||'', b.description_en||'', b.description_zh||'',
        image, parseInt(b.stock||'0',10), b.category||'',
        b.active != null ? parseInt(b.active,10) : 1,
        maxSort + 10,
        b.care_tips_en||'', b.care_tips_zh||'', Date.now());
  res.json({ id: info.lastInsertRowid });
});

// Admin: update seedling
app.put('/api/admin/seedlings/:id', requireAdmin, upload.single('image'), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cur = db.prepare('SELECT * FROM seedlings WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const f = (k) => req.body[k] != null ? req.body[k] : cur[k];
  const stock = req.body.stock != null ? parseInt(req.body.stock, 10) : cur.stock;
  const active = req.body.active != null ? parseInt(req.body.active, 10) : cur.active;
  const sort_order = req.body.sort_order != null ? parseInt(req.body.sort_order, 10) : cur.sort_order;
  const image = req.file ? '/uploads/' + req.file.filename : (req.body.image_url || cur.image);
  db.prepare(`UPDATE seedlings SET name_en=?, name_zh=?, variety_en=?, variety_zh=?, description_en=?, description_zh=?, image=?, stock=?, category=?, active=?, sort_order=?, care_tips_en=?, care_tips_zh=? WHERE id=?`)
    .run(f('name_en'), f('name_zh'), f('variety_en'), f('variety_zh'), f('description_en'), f('description_zh'),
         image, stock, f('category'), active, sort_order, f('care_tips_en'), f('care_tips_zh'), id);
  res.json({ ok: true });
});

// Admin: nudge sort up/down (swap with neighbor)
app.post('/api/admin/seedlings/:id/move', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const dir = req.body && req.body.dir === 'down' ? 'down' : 'up';
  const cur = db.prepare('SELECT * FROM seedlings WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  const neighbor = dir === 'up'
    ? db.prepare('SELECT * FROM seedlings WHERE sort_order < ? OR (sort_order = ? AND id > ?) ORDER BY sort_order DESC, id ASC LIMIT 1').get(cur.sort_order, cur.sort_order, cur.id)
    : db.prepare('SELECT * FROM seedlings WHERE sort_order > ? OR (sort_order = ? AND id < ?) ORDER BY sort_order ASC, id DESC LIMIT 1').get(cur.sort_order, cur.sort_order, cur.id);
  if (!neighbor) return res.json({ ok: true });
  db.transaction(() => {
    db.prepare('UPDATE seedlings SET sort_order=? WHERE id=?').run(neighbor.sort_order, cur.id);
    db.prepare('UPDATE seedlings SET sort_order=? WHERE id=?').run(cur.sort_order, neighbor.id);
  })();
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
  "description_en": "Start with one '⭐ ' line stating THE single most important / distinctive trait of THIS variety (heat tolerance / dwarf / disease resistance / huge fruit / determinate vs indeterminate etc.) — then a blank line — then a polished 2-4 sentence description: taste, size, growing notes.",
  "name_zh": "natural Chinese name",
  "variety_zh": "Chinese for variety_en",
  "description_zh": "Same structure as description_en in fluent Chinese: '⭐ '行 + 空行 + 2-4句描述。",
  "category": "broad category in English (e.g. 'Tomato', 'Pepper', 'Greens', 'Herb')",
  "care_tips_en": "1-3 sentences of variety-specific practical care tips: light, water, spacing, support, when/how to harvest",
  "care_tips_zh": "fluent Chinese translation of care_tips_en"
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

// Admin: research a variety by name — Claude web-searches and fills the form
app.post('/api/admin/research', requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set' });
  try {
    const prompt = `You are researching a plant/seedling variety the user wants to sell. Use web search to look up authoritative info (seed catalogs, Baker Creek, Johnny's, university extension sites). The variety is:

"${name}"

Find: common name, cultivar/type info, taste, size, growth habit (determinate/indeterminate, height), days to maturity, what makes this variety distinctive vs others, basic care tips, and a representative image URL (direct .jpg/.png/.webp).

Then return ONLY a single valid JSON object, no markdown, no commentary, no surrounding text:
{
  "name_en": "common product name in English",
  "variety_en": "variety / cultivar info in English (e.g. 'Heirloom Indeterminate Beefsteak')",
  "description_en": "Start with one '⭐ ' line stating THE single most distinctive trait of THIS variety — then a blank line — then 2-4 sentences: taste, size, growing notes",
  "name_zh": "natural Chinese name",
  "variety_zh": "Chinese translation of variety_en",
  "description_zh": "Same structure as description_en in fluent Chinese: '⭐ '行 + 空行 + 2-4句描述",
  "category": "broad category in English (e.g. 'Tomato', 'Pepper', 'Greens', 'Herb')",
  "care_tips_en": "1-3 sentences of variety-specific practical care tips",
  "care_tips_zh": "fluent Chinese translation of care_tips_en",
  "image_url": "direct image URL (jpg/png/webp), or empty string"
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
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages: [{ role: 'user', content: prompt }]
      })
    });
    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(500).json({ error: 'Claude API error: ' + t.slice(0, 500) });
    }
    const aiJson = await aiRes.json();
    // Concat all text blocks (tool-use blocks are skipped)
    const text = (aiJson.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const jm = text.match(/\{[\s\S]*\}/);
    if (!jm) return res.status(500).json({ error: 'Could not parse JSON', raw: text.slice(0, 500) });
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
  "description_en": "Start with one '⭐ ' line stating THE single most important / distinctive trait of THIS variety — then a blank line — then 2-4 sentences: taste, size, growing notes",
  "name_zh": "natural Chinese name",
  "variety_zh": "Chinese translation of variety_en",
  "description_zh": "Same structure as description_en in fluent Chinese: '⭐ '行 + 空行 + 2-4句描述",
  "category": "broad category in English (e.g. 'Tomato', 'Pepper', 'Greens', 'Herb')",
  "care_tips_en": "1-3 sentences of variety-specific practical care tips",
  "care_tips_zh": "fluent Chinese translation of care_tips_en",
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
    sendOrderEmail({ id: r.id, buyer_name, contact, note, token: r.token, view_password: r.view_password }, items.map(it => {
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

// Admin: export all orders as CSV
app.get('/api/admin/orders.csv', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM orders ORDER BY id ASC').all();
  const esc = v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const header = ['order_id','time','buyer','contact','note','seedling_id','name_en','name_zh','variety_en','qty'];
  const lines = [header.join(',')];
  for (const r of rows) {
    const items = enrichItems(JSON.parse(r.items_json));
    const time = new Date(r.created_at).toISOString();
    for (const it of items) {
      lines.push([r.id, time, r.buyer_name, r.contact||'', r.note||'', it.id, it.name_en||'', it.name_zh||'', it.variety_en||'', it.qty].map(esc).join(','));
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="orders-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send('\ufeff' + lines.join('\n'));
});

app.delete('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const id = parseInt(req.params.id, 10);
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT items_json FROM orders WHERE id=?').get(id);
    if (!row) return false;
    const items = JSON.parse(row.items_json);
    const upd = db.prepare('UPDATE seedlings SET stock = stock + ? WHERE id=?');
    for (const it of items) upd.run(it.qty, it.id);
    db.prepare('DELETE FROM orders WHERE id=?').run(id);
    return true;
  });
  if (!tx()) return res.status(404).json({ error: 'not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Seedlings4All running on http://localhost:${PORT}`);
  console.log(`  English: http://localhost:${PORT}/`);
  console.log(`  中文:    http://localhost:${PORT}/cn`);
  console.log(`  Admin:   http://localhost:${PORT}/admin   (password: ${ADMIN_PASSWORD})`);
});
