# JEDDAH MULTI-CATEGORY DELIVERY PLATFORM — Master Build Plan

**Project:** Fiasta — Jeddah multi-category delivery platform
**Source intelligence:** Static reconstruction reports of **Mrsool v4.3.0** and **SMSA Mobile v2.7**
(`/home/ubuntu/apks/reports/*.pdf`) — their proven UX flows, API shapes and state machines are
reused as design references; **no code, keys, or credentials from either app are copied.**

---

## 1. What we learned from the two reverse-engineered apps

### From Mrsool (consumer on-demand delivery super-app)
| Pattern observed | How we use it |
|---|---|
| Phone → OTP → session token auth (`auth/signin` + `verify_code`) | Same flow: `POST /api/auth/otp/request` → `POST /api/auth/otp/verify` → JWT. OTP provider is pluggable (debug mode returns the code for the demo). |
| Home screen = horizontal **category feed** + services, not a single vertical | Home is a category grid driven entirely by the `categories` table (active/disabled/partner-only/compliance-approved). |
| Multi-step order creation: addresses → items → vehicle → options → checkout | Booking wizard: Pickup → Drop-off(s) → Items (+photos, dimensions) → Helpers/stairs/floor → Price preview → Confirm. |
| Order **state machine** with explicit `update_order_state` transitions | Server-enforced state machine: `pending → assigned → accepted → en_route_pickup → at_pickup → loading → in_transit → at_dropoff → delivered / cancelled / failed`. Every transition emits a realtime event + audit row. |
| Live tracking via **WebSocket** (ActionCable in Mrsool) | Socket.IO rooms per order (`order:{id}`); driver GPS ping every 5 s while on a job. |
| Driver "courier mode": online/offline, accept/reject, shift availability | Driver app home = availability toggle + job offer cards with 60 s countdown, auto-expire → re-dispatch. |
| In-app chat between customer and driver | Socket.IO `order:{id}:chat` room + persisted `chat_messages` table. |
| Ratings + tips after delivery | `deliveries.rating`, `deliveries.tip`. |
| Saved addresses, promo codes, wallet | All included (wallet is demo/mock; payment gateway is an integration stub). |

### From SMSA Mobile (logistics / courier)
| Pattern observed | How we use it |
|---|---|
| **Rate inquiry before booking** (`RateInquiry`) | `POST /api/quote` returns a transparent itemised price *before* any order is created — the customer confirms the quoted price. |
| **AWB / waybill** model (`GenerateAWB`, tracking by number, EDD) | Every order gets a human-readable **waybill `FIA-YYMMDD-XXXX`** + estimated delivery window; tracking works by waybill number without login (public tracking page). |
| Sender/consignee **address book** with map validation | `addresses` table with lat/lng, district, label; Google Maps autocomplete (stubbed to Jeddah gazetteer in demo). |
| **Proof of delivery**: receiver name + signature + photos | POD package: delivery OTP **or** receiver name + signature canvas + photos + GPS stamp. |
| Business customers: bulk shipments, monthly invoices | Merchant portal: CSV bulk import, monthly statement (`invoices` table), negotiated rate cards. |
| PayFort / STC Pay | Payment gateway is an **integration stub** (`payments` table with `mock` provider); COD supported; clearly marked as not-live. |

### Security lessons (what we do differently)
Mrsool: trusted user CAs + bundled proxy CA + cleartext + no pinning (CRITICAL). SMSA: plaintext
backend credentials in the client (CRITICAL). Our rules:
1. No secrets in any client app. All third-party keys live server-side.
2. HTTPS-only; HSTS; no cleartext; certificate pinning documented for the native shells.
3. Every exported/deep-link surface is authenticated; deep links require signed tokens.
4. LPG orders are **server-gated**, never client-gated: the API refuses LPG dispatch unless the
   driver+vehicle pair has verified compliance rows in the DB.

---

## 2. Architecture

```
/home/ubuntu/saudi-delivery/
├── PLAN.md                  ← this file
├── backend/                 ← Node 22, Express, node:sqlite (SQLite/Postgres-compatible schema), Socket.IO
│   └── src/                 ← auth, db, orders, pricing, realtime, routes, seed
│   └── public/              ← all four web frontends served statically
│       ├── customer/        ← Customer App (PWA, installable on Android/iOS)
│       ├── driver/          ← Driver App (PWA)
│       ├── merchant/        ← Merchant Portal
│       └── admin/           ← Admin & Super Admin Dashboard
├── docs/                    ← API.md, DEPLOYMENT.md, TESTING.md
└── i18n/                    ← en.json, ar.json (shared by all frontends)
```

**Why SQLite now:** zero-dependency, same SQL schema ports to PostgreSQL for production
(`docs/DEPLOYMENT.md` documents the migration). All DB access goes through one `db.js`.

**Why PWAs for the apps:** the same API serves native Android/iOS shells later (WebView/Capacitor
or Kotlin Compose per the Mrsool blueprint). The demo is fully clickable end-to-end today.

### Data model (core tables)
`users(role: customer|driver|merchant|admin|super_admin)` · `driver_profiles` (vehicle, payload kg,
volume m³, lpg_eligible) · `vehicles` (class, payload, plate, lpg_approved) · `categories`
(slug, state: active|disabled|partner_only|compliance_approved, AR/EN names, icon) · `category_items`
(per-category product/size presets) · `zones` (Jeddah districts, polygon centre + radius, surcharge) ·
`pricing_config` (JSON knobs: base bands, bulky item fee, extra stop, helper, stairs, priority,
waiting time, VAT %) · `orders` + `order_stops` + `order_items` + `order_events` · `quotes` ·
`chat_messages` · `pod_records` (otp, signature path, photos, gps) · `merchants` + `merchant_rates` ·
`water_products` (brand, size, price, stock) + `water_stock_moves` · `lpg_compliance`
(document rows per driver/vehicle, verified flag) · `invoices` + `invoice_lines` · `promos` ·
`audit_log` · `notifications` · `payments` (mock gateway) · `claims` (damage/refund).

### Pricing engine (all knobs in `pricing_config`, editable in Admin)
- Distance bands (km → SAR): 0–5: 50–65 · 5–10: 60–85 · 10–15: 75–110 · 15–20: 95–135 · 20+: custom quote.
- Bulky item surcharge: standard 80–130, multiple 130–250+ (count × size tier).
- Extra stop 15–25 · Extra helper 25–50 · Stairs (no elevator) per floor · Priority surcharge %
- Waiting time per 10 min after grace · Zone surcharge per district · Vehicle class multiplier.
- Minimum charge **SAR 50** enforced server-side. VAT 15% added and shown separately.
- Water: product cost line + delivery fee line, separately configurable.
- LPG: separate partner price list, only visible to approved partners.

### Order state machine
`pending → assigned → accepted → en_route_pickup → at_pickup → loading → in_transit →
at_dropoff → delivered` with `cancelled`, `failed` terminal states. LPG orders can only be
assigned to drivers whose `lpg_compliance` is verified AND whose vehicle is `lpg_approved`.
Vehicle payload/size limits are checked at assignment (a 4-item bulky sofa load cannot go to a
small van class).

### Category states (Admin-controlled)
`active` · `disabled` · `partner_only` · `compliance_approved`.
**LPG seeds as `disabled`** with a compliance checklist; Admin must verify distributor licence,
vehicle approval and driver approval rows before the API will accept LPG orders. Water is active
with its own supplier/product/stock management. No restaurant/food category exists anywhere.

---

## 3. The four frontends (all AR/EN, RTL/LTR, navy #0B1F3A / white / electric blue #2E6BFF)

1. **Customer App** (`/app`) — OTP login, category grid, booking wizard, photo upload, quote,
   instant/scheduled, multi-stop, water repeat orders, live tracking map, delivery OTP, POD view,
   order history/invoices, support tickets. Demo payments (mock card + COD).
2. **Driver App** (`/driver`) — availability toggle, job offers, item checklist, pickup photos,
   loading confirmation, navigation handoff (Google Maps link), delivery OTP, signature POD,
   earnings, incident reporting. LPG jobs appear only for compliant partners.
3. **Merchant Portal** (`/merchant`) — registration, CSV bulk import, address book, negotiated
   rates, multi-stop, returns/exchanges, monthly invoices, POD downloads.
4. **Admin Dashboard** (`/admin`) — KPIs, live fleet map, dispatch (manual+auto), drivers/vehicles,
   category & item management, pricing editor, zones, merchants, water supplier stock, LPG
   compliance verification, promos, VAT, payments reconciliation, settlements, invoices, claims,
   support, reports/CSV export, audit log, RBAC roles.

Maps: Google Maps JS API is an **integration stub** — the demo renders a lightweight canvas/SVG
map of Jeddah with real district coordinates so everything works offline; `MAPS_PROVIDER` config
switches to real Google Maps when a key is supplied.

---

## 4. Build order (this session)
1. ✅ Plan (this document)
2. Backend schema + seed (Jeddah districts, 5 HiAce vans, drivers, categories, water products, LPG compliance pending)
3. Pricing engine + order state machine + dispatch + RBAC
4. Customer app → driver app → admin → merchant (shared design system + i18n)
5. API docs, test suite, deployment doc, end-to-end demo verification

## 5. Explicitly mocked / not live (labelled in-UI)
- SMS OTP (debug codes shown on screen), Push notifications (in-app only), Payment gateway
  (mock provider, COD real), Google Maps (offline Jeddah map unless key provided), XMPP-style
  chat is Socket.IO, PDF invoices generated client-side.
