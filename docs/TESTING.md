# Fiasta — Testing & Deployment

## Run the demo (this machine)
```bash
cd /home/ubuntu/saudi-delivery/backend
JWT_SECRET=<secret> OTP_DEBUG=true node src/server.js   # or: ./dev.sh
```
- Landing: http://localhost:3000/ — links to all four apps
- Customer: `/app` (login `0555000111`) · Driver: `/driver` (`0555100002`)
- Merchant: `/merchant` (`0556200001`) · Admin: `/admin` (`0500000000`)
- OTP is shown on screen in demo mode.

## Test suite
```bash
npm test        # 13 end-to-end API tests (in-memory DB, own server instance)
```
Covers: OTP auth, SAR 50 minimum fee, bulky pricing, auto-dispatch, LPG gate,
vehicle capacity rejection, order state machine (incl. illegal transitions),
public waybill tracking, RBAC, live pricing updates, water stock decrement/restore
on cancel, merchant CSV import.

## UI smoke test (optional)
```bash
cd /home/ubuntu/pw && node fiasta-qa.mjs
```
Drives the real admin login → 8 dashboard views, and customer login → category →
booking wizard → quote → booking → tracking, via headless Chromium.
(Note: this sandbox's Chromium renders no text glyphs — layout/DOM assertions only.)

## Production deployment
1. **Database**: SQLite (WAL) is used for the pilot. For scale, port to PostgreSQL —
   all SQL is standard except `datetime('now')` → `now()` and `node:sqlite` → `pg`.
   Schema is in `src/db.js` (single source of truth, migration list included).
2. **Secrets**: set `JWT_SECRET` (32+ random bytes), `ADMIN_PHONES`, `OTP_DEBUG=false`.
   Never ship secrets in client apps (lesson from the SMSA/Mrsool audits).
3. **HTTPS only**: terminate TLS at nginx/Caddy; HSTS header is already sent.
   Enable certificate pinning in the native app shells.
4. **SMS OTP**: implement `requestOtp()` in `src/auth.js` with Unifonic/Taqnyat/Msegat.
5. **Payments**: `payments` table + `/api/payments` reconciliation are ready for
   PayFort/STC Pay/Moyasar integration; provider `mock` must be replaced.
6. **Maps**: replace `renderMap()` in `public/shared/app.js` with Google Maps JS API
   (`MAPS_PROVIDER` config); geocoding for the address picker likewise.
7. **Push**: wire FCM to `device_tokens` (table + endpoint already exist).
8. **Backups**: `sqlite3 data/delivery.db ".backup backup-$(date +%F).db"` hourly cron,
   or WAL archiving; log shipping for `audit_log`.
9. **Process**: `systemd` unit or `pm2`; `PORT=3000` behind reverse proxy.
10. **RBAC**: roles are enforced in `requireAuth(...roles)` per route; audit every
    admin mutation (`audit()` helper already called across admin routes).

## Known stubs (labelled in-UI)
| Area | Status |
|---|---|
| SMS OTP | debug codes on screen; gateway integration pending |
| Payment gateway | mock provider + COD; PayFort/STC Pay pending |
| Google Maps | offline Jeddah map renderer; SDK swap documented |
| Push notifications | tokens stored; FCM send pending |
| Native apps | PWAs now; Kotlin Compose shells per blueprint when store-ready |
