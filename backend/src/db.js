import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

// SCHEMA_VERSION is bumped by migrations; see migrations below.
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============ IDENTITY & ACCESS ============
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL UNIQUE,              -- E.164, e.g. +9665XXXXXXXX
  name        TEXT NOT NULL DEFAULT '',
  email       TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'customer'
              CHECK (role IN ('customer','driver','merchant','admin','super_admin')),
  active      INTEGER NOT NULL DEFAULT 1,
  lang        TEXT NOT NULL DEFAULT 'ar' CHECK (lang IN ('ar','en')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS addresses (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL DEFAULT 'customer' CHECK (owner_type IN ('customer','merchant')),
  label     TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  district  TEXT NOT NULL DEFAULT '',
  address   TEXT NOT NULL,
  lat       REAL NOT NULL,
  lng       REAL NOT NULL,
  floor_no  INTEGER,
  has_elevator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ FLEET ============
CREATE TABLE IF NOT EXISTS vehicles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  plate        TEXT NOT NULL UNIQUE,
  model        TEXT NOT NULL,
  class        TEXT NOT NULL DEFAULT 'hiace' CHECK (class IN ('hiace','hiace_high_roof','box_truck')),
  payload_kg   REAL NOT NULL DEFAULT 900,
  volume_m3    REAL NOT NULL DEFAULT 7.8,
  lpg_approved INTEGER NOT NULL DEFAULT 0,   -- separate safety approval for LPG
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id        INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  vehicle_id     INTEGER REFERENCES vehicles(id),
  license_no     TEXT NOT NULL DEFAULT '',
  national_id    TEXT NOT NULL DEFAULT '',
  approved       INTEGER NOT NULL DEFAULT 0,
  availability   TEXT NOT NULL DEFAULT 'offline' CHECK (availability IN ('offline','online','busy')),
  lat            REAL,
  lng            REAL,
  location_at    TEXT,
  rating         REAL NOT NULL DEFAULT 5.0,
  total_jobs     INTEGER NOT NULL DEFAULT 0,
  lpg_certified  INTEGER NOT NULL DEFAULT 0,  -- driver-level LPG training certificate
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ CATALOG (everything Admin-configurable) ============
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  slug        TEXT NOT NULL UNIQUE,
  name_en     TEXT NOT NULL,
  name_ar     TEXT NOT NULL,
  desc_en     TEXT NOT NULL DEFAULT '',
  desc_ar     TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'box',
  -- active | disabled | partner_only | compliance_approved
  state       TEXT NOT NULL DEFAULT 'active'
              CHECK (state IN ('active','disabled','partner_only','compliance_approved')),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  requires_helpers INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS category_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  name_en      TEXT NOT NULL,
  name_ar      TEXT NOT NULL,
  size_tier    TEXT NOT NULL DEFAULT 'standard' CHECK (size_tier IN ('standard','bulky','extra_bulky')),
  est_weight_kg REAL NOT NULL DEFAULT 10,
  est_volume_m3 REAL NOT NULL DEFAULT 0.1,
  active       INTEGER NOT NULL DEFAULT 1
);

-- Water supplier catalog (separate product/stock/price management)
CREATE TABLE IF NOT EXISTS water_products (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_id  INTEGER NOT NULL REFERENCES merchants(id),
  brand_en     TEXT NOT NULL,
  brand_ar     TEXT NOT NULL,
  size_label   TEXT NOT NULL,               -- e.g. "330ml x 24", "5 gallon"
  unit_price   REAL NOT NULL,               -- SAR per unit
  stock_qty    INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS water_stock_moves (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES water_products(id) ON DELETE CASCADE,
  delta       INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  order_id    INTEGER REFERENCES orders(id),
  at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ ZONES & PRICING ============
CREATE TABLE IF NOT EXISTS zones (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name_en    TEXT NOT NULL,
  name_ar    TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  radius_km  REAL NOT NULL DEFAULT 4,
  surcharge  REAL NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS pricing_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL,                       -- JSON value
  label TEXT NOT NULL DEFAULT ''
);

-- ============ MERCHANTS ============
CREATE TABLE IF NOT EXISTS merchants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  cr_number     TEXT NOT NULL DEFAULT '',    -- commercial registration
  vat_number    TEXT NOT NULL DEFAULT '',
  category_id   INTEGER REFERENCES categories(id),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','suspended')),
  negotiated_discount_pct REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ ORDERS ============
CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  waybill         TEXT NOT NULL UNIQUE,      -- NAW-YYMMDD-XXXX
  customer_id     INTEGER REFERENCES users(id),
  merchant_id     INTEGER REFERENCES merchants(id),
  category_id     INTEGER NOT NULL REFERENCES categories(id),
  driver_id       INTEGER REFERENCES users(id),
  vehicle_id      INTEGER REFERENCES vehicles(id),
  -- pending, assigned, accepted, en_route_pickup, at_pickup, loading,
  -- in_transit, at_dropoff, delivered, cancelled, failed
  status          TEXT NOT NULL DEFAULT 'pending',
  is_scheduled    INTEGER NOT NULL DEFAULT 0,
  scheduled_for   TEXT,
  priority        TEXT NOT NULL DEFAULT 'standard' CHECK (priority IN ('standard','priority')),
  payment_method  TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card','merchant_account')),
  payment_status  TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','paid','refunded')),
  distance_km     REAL NOT NULL DEFAULT 0,
  delivery_fee    REAL NOT NULL DEFAULT 0,   -- SAR before VAT
  vat             REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  price_breakdown TEXT NOT NULL DEFAULT '{}',-- JSON itemised quote
  quote_note      TEXT NOT NULL DEFAULT '',
  needs_helpers   INTEGER NOT NULL DEFAULT 0,
  helpers_count   INTEGER NOT NULL DEFAULT 0,
  floor_pickup    INTEGER,
  elevator_pickup INTEGER NOT NULL DEFAULT 0,
  floor_dropoff   INTEGER,
  elevator_dropoff INTEGER NOT NULL DEFAULT 0,
  photos_json     TEXT NOT NULL DEFAULT '[]',-- customer item photos (paths)
  cancel_reason   TEXT NOT NULL DEFAULT '',
  rating          INTEGER CHECK (rating BETWEEN 1 AND 5),
  rating_comment  TEXT NOT NULL DEFAULT '',
  tip             REAL NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_driver ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_waybill ON orders(waybill);

CREATE TABLE IF NOT EXISTS order_stops (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('pickup','dropoff')),
  seq         INTEGER NOT NULL DEFAULT 1,
  address     TEXT NOT NULL,
  district    TEXT NOT NULL DEFAULT '',
  lat         REAL NOT NULL,
  lng         REAL NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  done        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS order_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  category_item_id INTEGER REFERENCES category_items(id),
  name        TEXT NOT NULL,
  qty         INTEGER NOT NULL DEFAULT 1,
  size_tier   TEXT NOT NULL DEFAULT 'standard',
  est_weight_kg REAL NOT NULL DEFAULT 0,
  est_volume_m3 REAL NOT NULL DEFAULT 0,
  width_cm    REAL, height_cm REAL, depth_cm REAL,
  photo_path  TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS order_events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status    TEXT NOT NULL,
  actor_id  INTEGER REFERENCES users(id),
  note      TEXT NOT NULL DEFAULT '',
  lat       REAL, lng REAL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS driver_locations (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id  INTEGER REFERENCES orders(id) ON DELETE CASCADE,
  lat       REAL NOT NULL, lng REAL NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  body      TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Proof of delivery: OTP and/or signature + photos + GPS
CREATE TABLE IF NOT EXISTS pod_records (
  order_id     INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  method       TEXT NOT NULL CHECK (method IN ('otp','signature','both')),
  otp_verified INTEGER NOT NULL DEFAULT 0,
  receiver_name TEXT NOT NULL DEFAULT '',
  signature_path TEXT NOT NULL DEFAULT '',
  photos_json  TEXT NOT NULL DEFAULT '[]',
  gps_lat      REAL, gps_lng REAL,
  delivered_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============ LPG COMPLIANCE GATE ============
CREATE TABLE IF NOT EXISTS lpg_compliance (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id   INTEGER NOT NULL REFERENCES users(id),
  vehicle_id  INTEGER NOT NULL REFERENCES vehicles(id),
  doc_type    TEXT NOT NULL,   -- distributor_licence | vehicle_approval | driver_cert | insurance
  doc_ref     TEXT NOT NULL DEFAULT '',
  verified    INTEGER NOT NULL DEFAULT 0,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (driver_id, vehicle_id, doc_type)
);

-- ============ COMMERCIALS ============
CREATE TABLE IF NOT EXISTS promos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL UNIQUE,
  kind       TEXT NOT NULL DEFAULT 'percent' CHECK (kind IN ('percent','fixed')),
  value      REAL NOT NULL,
  min_order  REAL NOT NULL DEFAULT 0,
  max_uses   INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider   TEXT NOT NULL DEFAULT 'mock',  -- mock | cod | stc_pay | mada (integration stubs)
  amount     REAL NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','captured','failed','refunded')),
  reference  TEXT NOT NULL DEFAULT '',
  at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT NOT NULL UNIQUE,          -- INV-YYMM-XXXX
  merchant_id INTEGER REFERENCES merchants(id),
  customer_id INTEGER REFERENCES users(id),
  period      TEXT NOT NULL,                 -- YYYY-MM
  subtotal    REAL NOT NULL DEFAULT 0,
  vat         REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','issued','paid')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  order_id   INTEGER REFERENCES orders(id),
  description TEXT NOT NULL,
  amount     REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS driver_settlements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id  INTEGER NOT NULL REFERENCES users(id),
  period     TEXT NOT NULL,
  jobs       INTEGER NOT NULL DEFAULT 0,
  gross      REAL NOT NULL DEFAULT 0,
  commission_pct REAL NOT NULL DEFAULT 30,
  payout     REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  UNIQUE (driver_id, period)
);

CREATE TABLE IF NOT EXISTS claims (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  opened_by  INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL CHECK (kind IN ('damage','refund','complaint')),
  description TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected')),
  resolution TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS support_tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  order_id   INTEGER REFERENCES orders(id),
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','closed')),
  reply      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id  INTEGER REFERENCES users(id),
  action    TEXT NOT NULL,
  entity    TEXT NOT NULL DEFAULT '',
  entity_id INTEGER,
  detail    TEXT NOT NULL DEFAULT '',
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  read        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Device push tokens (integration stub for FCM)
CREATE TABLE IF NOT EXISTS device_tokens (
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token     TEXT NOT NULL,
  platform  TEXT NOT NULL DEFAULT 'android',
  PRIMARY KEY (user_id, token)
);
`;

// Ordered migrations: each runs once, tracked in meta.
const MIGRATIONS = [
  { v: 1, name: 'initial-schema', sql: null }, // schema above is v1
];

let db;

/** Open (or create) the database and apply schema + migrations. Pass ':memory:' for tests. */
export function openDb(path = config.dbPath) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec(SCHEMA);
  for (const m of MIGRATIONS) {
    const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(`migration:${m.v}`);
    if (done) continue;
    if (m.sql) db.exec(m.sql);
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(`migration:${m.v}`, m.name);
  }
  return db;
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export function all(sql, ...params) {
  return getDb().prepare(sql).all(...params);
}

export function get(sql, ...params) {
  return getDb().prepare(sql).get(...params);
}

export function run(sql, ...params) {
  return getDb().prepare(sql).run(...params);
}

export function tx(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function audit(actorId, action, entity = '', entityId = null, detail = '') {
  run('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)',
    actorId, action, entity, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail));
}
