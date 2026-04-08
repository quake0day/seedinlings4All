# 🌱 Seedlings4All

A tiny bilingual (English / 中文) seedling shop you can host on a Raspberry Pi or any small Linux box. Share the link with friends, let them browse seedlings with photos and descriptions, add to cart, and check out — orders land in your admin console (and your inbox).

Built as a single Node.js + Express + SQLite app, no build step, no framework lock-in.

## Features

- 🌐 **Bilingual** — `/` English, `/cn` 中文. Every product field is stored in both languages.
- 🛒 **Cart + checkout** — atomic stock decrement (no overselling), polling-based real-time stock display.
- 🤖 **AI-assisted product entry** — paste a product URL and Claude scrapes name/description/image and translates everything; or paste a free-form blurb in any language and let Claude fill the form.
- 📧 **Email notifications** — get an SMTP email the moment a friend checks out, with the full item list.
- 🔗 **Customer order lookup** — every checkout returns a unique link + 6-digit password the buyer can use to view their order anytime.
- 🔁 **Live name updates** — rename a seedling in admin and existing orders display the new name automatically (joined live, snapshot kept as fallback if deleted).
- 📱 **Mobile-friendly** — responsive grid + slide-in cart drawer.
- 💾 **Persistent** — SQLite file on disk; survives restarts.

## Stack

- Node.js 20+ / Express
- `better-sqlite3` for storage
- `multer` for image upload, `nodemailer` for SMTP
- Vanilla HTML/CSS/JS frontend (no React, no build)
- Anthropic Claude API for the AI helpers

## Quick start

```bash
git clone https://github.com/quake0day/seedinlings4All.git
cd seedinlings4All
npm install

ADMIN_PASSWORD=changeme \
ANTHROPIC_API_KEY=sk-ant-... \
npm start
```

Then open:
- Shop (English): http://localhost:3000/
- Shop (中文): http://localhost:3000/cn
- Admin: http://localhost:3000/admin

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | no | Default `3000` |
| `ADMIN_PASSWORD` | yes | Password for the admin console |
| `ANTHROPIC_API_KEY` | optional | Enables URL scrape + blurb fill (uses Claude) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | optional | SMTP server (Gmail: `smtp.gmail.com` / `465` / `true`) |
| `SMTP_USER` / `SMTP_PASS` | optional | SMTP login (Gmail needs an [App Password](https://myaccount.google.com/apppasswords)) |
| `SMTP_FROM` | optional | From address (defaults to `SMTP_USER`) |
| `NOTIFY_EMAIL` | optional | Where to deliver order notifications |
| `PUBLIC_URL` | optional | Base URL used in admin links inside notification emails |

Email notifications activate only when `SMTP_HOST`, `SMTP_USER`, and `NOTIFY_EMAIL` are all set.

## Run as a service (systemd)

`/etc/systemd/system/seedlings.service`:

```ini
[Unit]
Description=Seedlings4All
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/home/youruser/seedinlings4All
Environment=PORT=3000
Environment=ADMIN_PASSWORD=changeme
Environment=ANTHROPIC_API_KEY=sk-ant-...
Environment=SMTP_HOST=smtp.gmail.com
Environment=SMTP_PORT=465
Environment=SMTP_SECURE=true
Environment=SMTP_USER=you@gmail.com
Environment=SMTP_PASS=app-password-here
Environment=NOTIFY_EMAIL=you@gmail.com
ExecStart=/usr/bin/node /home/youruser/seedinlings4All/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now seedlings
sudo journalctl -u seedlings -f
```

## Admin workflow

1. Open `/admin`, enter your `ADMIN_PASSWORD` (cached in browser).
2. Add seedlings — fill English + Chinese fields by hand, **or**:
   - Paste a product URL into **Auto-fill from URL** → Claude fetches & translates everything.
   - Paste a description blurb into **Fill from blurb** → Claude analyzes & translates.
3. Upload an image, or use the URL Claude found, or skip and a 🌱 placeholder shows.
4. Click **Add**. Click **Edit** on any row to update later — renames propagate to existing orders automatically.
5. Watch new orders appear at the bottom of the page, also delivered to your inbox.

## Customer flow

1. You share `http://your-host:3000/` (or `/cn`) with friends.
2. They browse, add to cart, check out with their name + contact + optional note.
3. The success modal gives them a **personal order link** (`/order?t=<token>`) and a **6-digit password**. They can revisit anytime.
4. You see the order in `/admin` and in your email.

## Data & backups

Two folders hold all state:

- `data/app.db` — SQLite database (seedlings + orders + tokens)
- `uploads/` — uploaded images

Both are gitignored. Back them up:

```bash
scp user@host:~/seedinlings4All/data/app.db ~/seedlings-backup-$(date +%F).db
```

## License

MIT
