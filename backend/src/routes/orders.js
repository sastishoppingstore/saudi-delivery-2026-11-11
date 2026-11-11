import { Router } from 'express';
import { mkdirSync, writeFileSync } from 'node:fs';
import { all, get, run, audit } from '../db.js';
import { requireAuth } from '../auth.js';
import { quote as computeQuote, getPricing } from '../pricing.js';
import { createOrder, getOrderFull, transition, ordersForUser, driverEligible, autoDispatch } from '../orders.js';
import { emitToDrivers, emitToAdmins, emitToUser, broadcastOrder } from '../realtime.js';
import { config } from '../config.js';

export const orderRoutes = Router();

const UPLOAD_DIR = new URL('../../data/uploads/', import.meta.url).pathname;

// ---------- Item photo upload (base64 data URL) ----------
orderRoutes.post('/upload', requireAuth('customer', 'driver', 'merchant'), (req, res) => {
  const { dataUrl, kind } = req.body || {};
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    return res.status(400).json({ error: 'dataUrl (image/*) required' });
  }
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'unsupported image format' });
  if (m[2].length > 4_000_000) return res.status(413).json({ error: 'image too large (max ~3 MB)' });
  mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const name = `${kind || 'item'}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  writeFileSync(UPLOAD_DIR + name, Buffer.from(m[2], 'base64'));
  res.status(201).json({ path: `/uploads/${name}` });
});

// ---------- Quote (SMSA-style rate inquiry BEFORE booking) ----------
orderRoutes.post('/quote', requireAuth('customer', 'merchant'), (req, res) => {
  try {
    const b = req.body || {};
    const items = (b.items || []).map((i) => ({
      size_tier: i.size_tier, qty: Number(i.qty) || 1,
      est_weight_kg: Number(i.est_weight_kg) || 0, est_volume_m3: Number(i.est_volume_m3) || 0,
    }));
    const q = computeQuote({
      pickup: b.pickup,
      stops: b.dropoffs || (b.dropoff ? [b.dropoff] : []),
      items,
      helpers: Number(b.helpers) || 0,
      floors: { pickup: Number(b.floorPickup) || 0, dropoff: Number(b.floorDropoff) || 0 },
      elevators: { pickup: !!b.elevatorPickup, dropoff: !!b.elevatorDropoff },
      priority: b.priority === true,
      vehicleClass: b.vehicleClass || 'hiace',
      zoneSurcharge: 0,
      waterUnits: (b.waterLines || []).reduce((s, w) => s + (Number(w.qty) || 0), 0),
    });
    res.json(q);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Create order ----------
orderRoutes.post('/orders', requireAuth('customer', 'merchant'), (req, res) => {
  try {
    const oid = createOrder(req.body, req.user);
    const order = getOrderFull(oid);
    if (!order.is_scheduled) {
      emitToDrivers('order:new', { orderId: oid, waybill: order.waybill, category: order.category_slug, pickup: order.stops.find((s) => s.kind === 'pickup') });
      emitToAdmins('order:new', { orderId: oid, waybill: order.waybill });
      // Attempt auto-dispatch (configurable; admin can also dispatch manually)
      if (String(req.body.autoDispatch ?? 'true') !== 'false') {
        const r = autoDispatch(oid);
        if (r.dispatched) emitToUser(r.driverId, 'order:offer', { orderId: oid, waybill: order.waybill });
      }
    }
    res.status(201).json(getOrderFull(oid));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ---------- List / detail ----------
orderRoutes.get('/orders', requireAuth(), (req, res) => {
  res.json(ordersForUser(req.user.id, req.user.role));
});

orderRoutes.get('/orders/:id', requireAuth(), (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const allowed = ['admin', 'super_admin'].includes(req.user.role)
    || o.customer_id === req.user.id || o.driver_id === req.user.id
    || (req.user.role === 'merchant' && o.merchant_id === get('SELECT id FROM merchants WHERE user_id = ?', req.user.id)?.id);
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  o.chat = all(`SELECT cm.id, cm.body, cm.at, u.name AS sender FROM chat_messages cm JOIN users u ON u.id = cm.sender_id WHERE cm.order_id = ? ORDER BY cm.id`, o.id);
  res.json(o);
});

/** Public tracking by waybill (SMSA-style) — no login needed, minimal fields. */
orderRoutes.get('/track/:waybill', (req, res) => {
  const o = get('SELECT id FROM orders WHERE waybill = ?', req.params.waybill.toUpperCase());
  if (!o) return res.status(404).json({ error: 'waybill not found' });
  const full = getOrderFull(o.id);
  res.json({
    waybill: full.waybill,
    status: full.status,
    category: full.category_slug,
    district: full.stops.find((s) => s.kind === 'dropoff')?.district || '',
    events: full.events.map((e) => ({ status: e.status, at: e.at, note: e.note })),
    estimatedWindow: full.scheduled_for || 'same-day',
  });
});

// ---------- Lifecycle ----------
orderRoutes.post('/orders/:id/cancel', requireAuth('customer', 'merchant', 'admin', 'super_admin'), (req, res) => {
  try {
    const o = getOrderFull(req.params.id);
    if (!o) return res.status(404).json({ error: 'order not found' });
    const updated = transition(o.id, 'cancelled', req.user, String(req.body?.reason || '').slice(0, 200));
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

orderRoutes.post('/orders/:id/state', requireAuth('driver', 'admin', 'super_admin'), (req, res) => {
  try {
    const next = String(req.body?.status || '');
    const gps = req.body?.lat != null ? { lat: Number(req.body.lat), lng: Number(req.body.lng) } : null;
    const updated = transition(Number(req.params.id), next, req.user, String(req.body?.note || ''), gps);
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

orderRoutes.post('/orders/:id/rate', requireAuth('customer'), (req, res) => {
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
  const o = getOrderFull(req.params.id);
  if (!o || o.customer_id !== req.user.id) return res.status(404).json({ error: 'order not found' });
  if (o.status !== 'delivered') return res.status(409).json({ error: 'only delivered orders can be rated' });
  if (o.rating) return res.status(409).json({ error: 'already rated' });
  run('UPDATE orders SET rating = ?, rating_comment = ?, tip = ? WHERE id = ?',
    rating, String(req.body.comment || '').slice(0, 300), Math.max(0, Number(req.body.tip) || 0), o.id);
  audit(req.user.id, 'order.rate', 'orders', o.id, { rating });
  res.json(getOrderFull(o.id));
});

// ---------- Proof of delivery ----------
orderRoutes.post('/orders/:id/pod', requireAuth('driver'), (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  if (o.driver_id !== req.user.id) return res.status(403).json({ error: 'not your order' });
  if (o.status !== 'at_dropoff') return res.status(409).json({ error: `deliver first (status: ${o.status})` });

  const method = ['otp', 'signature', 'both'].includes(req.body?.method) ? req.body.method : 'otp';
  let otpOk = method === 'signature';
  if (method === 'otp' || method === 'both') {
    const expected = get(`SELECT value FROM meta WHERE key = ?`, `pod_otp:${o.id}`);
    otpOk = expected && String(req.body?.otp || '').trim() === expected.value;
    if (!otpOk) return res.status(422).json({ error: 'delivery OTP does not match' });
  }
  if (method === 'signature' || method === 'both') {
    if (!req.body?.receiverName) return res.status(400).json({ error: 'receiverName required for signature POD' });
  }

  run(`INSERT INTO pod_records (order_id, method, otp_verified, receiver_name, signature_path, photos_json, gps_lat, gps_lng)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(order_id) DO UPDATE SET method = excluded.method, otp_verified = excluded.otp_verified,
         receiver_name = excluded.receiver_name, signature_path = excluded.signature_path,
         photos_json = excluded.photos_json, gps_lat = excluded.gps_lat, gps_lng = excluded.gps_lng`,
  o.id, method, otpOk ? 1 : 0, String(req.body.receiverName || '').slice(0, 80),
  String(req.body.signaturePath || ''), JSON.stringify(req.body.photos || []),
  Number(req.body.lat) || null, Number(req.body.lng) || null);

  const updated = transition(o.id, 'delivered', req.user, `POD: ${method}`);
  res.json(updated);
});

/** Customer fetches the delivery OTP to hand to the driver. */
orderRoutes.get('/orders/:id/delivery-otp', requireAuth('customer'), (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o || o.customer_id !== req.user.id) return res.status(404).json({ error: 'order not found' });
  if (!['in_transit', 'at_dropoff'].includes(o.status)) return res.status(409).json({ error: 'OTP available once the driver is on the way' });
  let row = get(`SELECT value FROM meta WHERE key = ?`, `pod_otp:${o.id}`);
  if (!row) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    run(`INSERT INTO meta (key, value) VALUES (?, ?)`, `pod_otp:${o.id}`, code);
    row = { value: code };
  }
  res.json({ otp: row.value });
});

// ---------- Customer support tickets ----------
orderRoutes.post('/support/tickets', requireAuth(), (req, res) => {
  const subject = String(req.body?.subject || 'Support').slice(0, 120);
  const body = String(req.body?.body || '').slice(0, 2000);
  const orderId = req.body?.orderId ? Number(req.body.orderId) : null;
  const r = run('INSERT INTO support_tickets (user_id, order_id, subject, body) VALUES (?, ?, ?, ?)',
    req.user.id, orderId, subject, body);
  res.status(201).json({ id: r.lastInsertRowid });
});

orderRoutes.get('/my/tickets', requireAuth(), (req, res) => {
  res.json(all('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 30', req.user.id));
});

// ---------- Pricing config (public read for the quote UI) ----------
orderRoutes.get('/pricing/public', (req, res) => {
  const p = getPricing();
  res.json({
    minFee: p.min_fee,
    bands: [p.band_1, p.band_2, p.band_3, p.band_4],
    extraStop: p.extra_stop,
    extraHelper: p.extra_helper,
    priorityPct: p.priority_pct,
    vatRate: p.vat_rate,
    currency: config.currency,
    note20km: p.band_custom_note,
  });
});
