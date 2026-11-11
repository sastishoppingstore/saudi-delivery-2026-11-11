# Fiasta — Deployment Guide

Production deployment of the Jeddah delivery platform (API + four web apps + Socket.IO).
The development/demo flow is in `TESTING.md`; this document covers running it for real.

## 1. Requirements
- Node.js **>= 22.13** (uses the built-in `node:sqlite` module)
- Linux host with a public domain, ports 80/443 open
- Reverse proxy with TLS (nginx or Caddy)

## 2. Install
```bash
git clone <repo> /opt/fiasta            # or copy the saudi-delivery/ folder
cd /opt/fiasta/backend
npm ci --omit=dev
mkdir -p data/uploads                    # SQLite DB + uploaded photos live here
```

## 3. Environment variables
All tunables are read in `backend/src/config.js`.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `JWT_SECRET` | **yes** | random per boot | Signs session JWTs. Use 32+ random bytes (`openssl rand -hex 32`). A random default logs everyone out on every restart. |
| `OTP_DEBUG` | **yes (prod)** | `true` | Must be `false` in production — otherwise OTP codes are returned in API responses. |
| `ADMIN_PHONES` | yes | `+966500000000` | Comma-separated numbers that get the admin role on first login. |
| `PORT` | no | `3000` | HTTP listen port (bind behind the proxy). |
| `DB_PATH` | no | `data/delivery.db` | SQLite file, relative to the working directory. |

Example `/etc/fiasta/fiasta.env` (mode `600`, owned by the service user):
```bash
JWT_SECRET=<openssl rand -hex 32 output>
OTP_DEBUG=false
ADMIN_PHONES=+9665XXXXXXXX
PORT=3000
DB_PATH=/opt/fiasta/backend/data/delivery.db
```

Never place secrets in the web apps or native shells (see the security lessons in `PLAN.md`).

## 4. Run as a service (systemd)
`/etc/systemd/system/fiasta.service`:
```ini
[Unit]
Description=Fiasta delivery platform
After=network.target

[Service]
Type=simple
User=fiasta
WorkingDirectory=/opt/fiasta/backend
EnvironmentFile=/etc/fiasta/fiasta.env
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fiasta
curl -s http://127.0.0.1:3000/health     # → {"ok":true,"app":"fiasta","city":"jeddah"}
```

## 5. Reverse proxy and TLS
Socket.IO needs WebSocket upgrade headers. nginx example:
```nginx
server {
    listen 443 ssl http2;
    server_name fiasta.example.sa;
    ssl_certificate     /etc/letsencrypt/live/fiasta.example.sa/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fiasta.example.sa/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    server_name fiasta.example.sa;
    return 301 https://$host$request_uri;
}
```
The app already sends `Strict-Transport-Security`, `X-Frame-Options: DENY`, `nosniff` and
`Referrer-Policy: no-referrer`. Do not serve it over plain HTTP.

## 6. Database
- SQLite in WAL mode is used for the pilot. Schema and migrations are in `backend/src/db.js`.
- Backups (hourly cron, safe while the app runs):
  ```bash
  sqlite3 /opt/fiasta/backend/data/delivery.db ".backup /var/backups/fiasta/delivery-$(date +%F-%H).db"
  ```
  Keep off-site copies and test a restore before go-live.
- Scaling: port to PostgreSQL. The schema uses `datetime('now')` defaults (→ `now()`) and the
  `node:sqlite` driver (→ `pg`); queries are spread across `src/` and `src/routes/`, so budget for
  a full audit when porting.

## 7. Seed data
`src/seed.js` creates demo zones, categories, drivers and vehicles. For a real launch, run
only with an empty database, then replace demo users and remove the demo accounts from the
admin dashboard (Users page). Do not seed with demo OTP codes in production.

## 8. Go-live checklist
- [ ] `JWT_SECRET` set (32+ bytes) and not committed to git
- [ ] `OTP_DEBUG=false`
- [ ] `ADMIN_PHONES` set to real staff numbers
- [ ] TLS certificate valid, HTTP redirects to HTTPS
- [ ] `/health` reachable through the proxy; Socket.IO connects (driver/customer live tracking)
- [ ] Backup job runs and a restore was tested
- [ ] `npm test` passes on the deployment host
- [ ] Integrations below replaced or formally accepted as pending

## 9. Integrations still stubbed (must be completed before live traffic)
| Area | Current state | Where to change |
|---|---|---|
| SMS OTP | Codes shown in debug mode only | `requestOtp()` in `src/auth.js` (Unifonic / Taqnyat / Msegat) |
| Payments | `mock` (card) and `cod` work; `stc_pay` / `mada` are placeholders | `payments` table in `src/db.js`, order creation in `src/orders.js`, reconcile at `/api/admin/payments` |
| Push | Token stored, no notification sent | `POST` device-token route in `src/routes/auth.js` → FCM |
| Maps | Offline Jeddah canvas renderer | `renderMap()` in `public/shared/app.js` → Google Maps JS API |
| LPG compliance | Seeded as pending; LPG orders blocked until verified | Admin → Compliance |

## 10. Updating
```bash
cd /opt/fiasta/backend
sudo systemctl stop fiasta
cp data/delivery.db data/delivery.db.bak-$(date +%F)   # take a backup first
npm ci --omit=dev
sudo systemctl start fiasta
curl -s http://127.0.0.1:3000/health
```

## 11. Translations
UI strings are in `i18n/en.json` and `i18n/ar.json` (repository root of `saudi-delivery/`).
The backend serves them at `/i18n/<lang>.json`; the web apps load them before first render.
Add a key to both files when adding UI text.
