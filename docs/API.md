# Fiasta API Documentation

Base URL: `http://localhost:3000/api` — all bodies are JSON. Auth: `Authorization: Bearer <JWT>`.
Roles: `customer`, `driver`, `merchant`, `admin`, `super_admin`.

## Auth (OTP)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/auth/otp/request` | `{phone}` | Saudi mobile `05XXXXXXXX`. Returns `{debugCode}` when `OTP_DEBUG=true` (demo). Production: SMS gateway (Unifonic/Taqnyat) — stub. |
| POST | `/auth/otp/verify` | `{phone, code, name?, lang?}` | Returns `{token, user}`. New numbers become customers; `ADMIN_PHONES` become super_admin. |
| POST | `/auth/driver/register` | `{phone, code, name, licenseNo, nationalId}` | Creates pending driver; admin must approve. |
| POST | `/auth/merchant/register` | `{phone, code, businessName, crNumber, vatNumber, categorySlug}` | Creates pending merchant. |

## Me / notifications
- `GET /me` → user + driver profile (vehicle, LPG flags) or merchant profile
- `PATCH /me` `{name?, lang?}`
- `GET /notifications` · `POST /notifications/read`
- `POST /device-token` `{token, platform}` — FCM stub (stored, no push sent)

## Catalog (public)
- `GET /categories?lang=ar|en` → categories with `state`: `active | disabled | partner_only | compliance_approved`
- `GET /categories/:slug/items` → size tiers, weights, volumes
- `GET /water/products` → supplier catalog with live stock
- `GET /zones` → Jeddah districts + surcharges
- `POST /promos/validate` `{code}`

## Quotes & orders
- `POST /quote` — itemised price **before** booking (SMSA-style rate inquiry). Input: `pickup, dropoffs[], items[], helpers, floors, elevators, priority, waterLines[]`. Response: `lines[], deliveryFee, waterCost, vat, total, customQuote` (20+ km → custom quotation). Minimum fee SAR 50 enforced server-side.
- `POST /orders` — create. Category state is enforced **server-side** (disabled → 403; partner/compliance categories require approved merchant). Vehicle payload/volume checked (422 if too big). Auto-dispatch assigns nearest eligible online driver. Body: `categorySlug, pickup{address,lat,lng,...}, dropoffs[], items[], waterLines[], helpers, floorPickup/Dropoff, elevatorPickup/Dropoff, priority, scheduledFor, paymentMethod(cash|card|merchant_account), promoCode, autoDispatch`.
- `GET /orders` — own orders (customer/driver/merchant scope)
- `GET /orders/:id` — full detail incl. events, POD, chat
- `GET /track/:waybill` — **public** tracking (no auth)
- `POST /orders/:id/state` `{status, note?, lat?, lng?}` — driver/admin; legal transitions enforced:
  `pending→assigned→accepted→en_route_pickup→at_pickup→loading→in_transit→at_dropoff→delivered` (+`cancelled`,`failed`)
- `POST /orders/:id/cancel` `{reason}`
- `POST /orders/:id/rate` `{rating 1-5, comment?, tip?}`
- `GET /orders/:id/delivery-otp` — customer fetches 4-digit delivery OTP
- `POST /orders/:id/pod` — driver submits POD `{method: otp|signature|both, otp?, receiverName?, signaturePath?, photos[], lat, lng}`
- `POST /upload` `{dataUrl}` — base64 image → `/uploads/...` path (item photos, pickup photos, signatures)
- `POST /support/tickets` `{subject, body, orderId?}` · `GET /my/tickets`

## Driver
- `POST /driver/availability` `{status: online|offline}`
- `GET /driver/jobs/available` — pending orders filtered by **server-side eligibility** (LPG compliance, vehicle capacity, availability)
- `POST /driver/jobs/:id/accept` · `POST /driver/jobs/:id/reject` (re-dispatches)
- `GET /driver/jobs/active` · `GET /driver/earnings` (today/week/month + settlements)
- `POST /driver/location` `{lat, lng, orderId?}` — streams to customer via Socket.IO
- `POST /driver/incidents` `{orderId, kind: damage|refund|complaint, description}`

## Merchant (`/merchant/*`, merchant or admin role)
- `GET /merchant` — profile + negotiated rates
- `GET /merchant/orders` · `GET /merchant/orders/:id` · `GET /merchant/orders/:id/pod` (POD download bundle)
- `POST /merchant/orders/bulk` `{orders[]}` — up to 100 per call
- `POST /merchant/orders/csv` `{csv}` — header: `pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,item_name,qty,size_tier,contact_name,contact_phone`
- `GET/POST /merchant/addresses` — address book
- `GET/POST/PATCH /merchant/water/products` — supplier product & stock management (`stockQty` changes logged to `water_stock_moves`)
- `GET /merchant/water/stock-moves` · `GET /merchant/invoices`

## Admin (`/admin/*`, admin/super_admin)
- `GET /admin/stats` — KPIs, revenue, fleet
- `GET /admin/fleet` — live driver positions
- `GET /admin/orders[?status=]` · `GET /admin/orders/:id`
- `GET /admin/dispatch/pending` — pending orders + eligible drivers · `POST /admin/dispatch/:orderId` `{driverId?}` (manual or auto)
- `GET /admin/drivers` · `POST /admin/drivers/:id/approve` · `POST /admin/drivers/:id/assign-vehicle`
- `GET/POST/PATCH /admin/vehicles` — payload, volume, `lpg_approved`
- `GET/POST/PATCH /admin/categories` — **state machine**: `active/disabled/partner_only/compliance_approved`; LPG cannot be set active without verified compliance (423)
- `POST /admin/categories/:id/items` · `PATCH /admin/items/:id`
- `GET /admin/pricing` · `PUT /admin/pricing/:key` `{value}` — live pricing knobs (bands, bulky, helpers, stairs, priority, VAT, waiting, vehicle multipliers, water fees)
- `GET/POST/PATCH /admin/zones`
- `GET /admin/merchants` · `POST /admin/merchants/:id/status` `{status, discountPct?}`
- `GET /admin/lpg/compliance` · `POST /admin/lpg/compliance` `{driverId, vehicleId, docType, docRef}` · `POST /admin/lpg/compliance/:id/verify` `{verified}` — when distributor_licence + vehicle_approval + driver_cert are all verified for a driver/vehicle pair, driver becomes `lpg_certified`, vehicle `lpg_approved`, and the LPG category auto-unlocks to `compliance_approved`
- `GET/POST /admin/promos` · `GET /admin/payments` · `POST /admin/payments/:id/reconcile`
- `GET /admin/settlements` · `POST /admin/settlements/generate` `{period}` · `POST /admin/settlements/:id/pay`
- `GET /admin/invoices` · `POST /admin/invoices/generate` `{period}`
- `GET /admin/claims` · `POST /admin/claims/:id` `{status, resolution, amount}`
- `GET /admin/support` · `POST /admin/support/:id/reply` `{reply}`
- `GET /admin/reports/orders.csv` · `GET /admin/reports/settlements.csv`
- `GET /admin/audit` — full audit trail
- `POST /admin/admins` `{phone}` — super_admin promotes an admin

## Realtime (Socket.IO)
Connect with `auth: {token}`. Rooms: `user:<id>`, `role:admins`, `role:drivers`, `order:<id>` (join via `order:join`).
Events: `order:new`, `order:updated`, `order:offer`, `driver:location`, `order:chat` (send `{orderId, body}`), `notification`, `driver:pending`, `merchant:pending`, `claim:new`, `category:updated`.
