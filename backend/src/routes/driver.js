import { Router } from 'express';
import { all, get, run, audit } from '../db.js';
import { requireAuth } from '../auth.js';
import { transition, driverEligible, autoDispatch } from '../orders.js';
import { emitToAdmins } from '../realtime.js';
import { haversineKm } from '../pricing.js';

export const driverRoutes = Router();

function profile(userId) {
  return get(`SELECT dp.*, v.plate, v.model, v.class, v.payload_kg, v.volume_m3, v.lpg_approved
    FROM driver_profiles dp LEFT JOIN vehicles v ON v.id = dp.vehicle_id WHERE dp.user_id = ?`, userId);
}

function canWork(userId) {
  const p = profile(userId);
  return Boolean(p?.approved) && p.availability !== 'offline';
}

// ---------- Availability ----------
driverRoutes.post('/driver/availability', requireAuth('driver'), (req, res) => {
  const status = req.body?.status;
  if (!['online', 'offline'].includes(status)) return res.status(400).json({ error: 'status online|offline' });
  const p = profile(req.user.id);
  if (!p?.approved) return res.status(403).json({ error: 'driver not approved yet' });
  if (p.availability === 'busy' && status === 'offline') return res.status(409).json({ error: 'finish your current order first' });
  run('UPDATE driver_profiles SET availability = ? WHERE user_id = ?', status, req.user.id);
  res.json({ availability: status });
});

// ---------- Job offers (only eligible ones; LPG filtered server-side) ----------
driverRoutes.get('/driver/jobs/available', requireAuth('driver'), (req, res) => {
  if (!canWork(req.user.id)) return res.status(403).json({ error: 'not approved or offline' });
  const me = profile(req.user.id);
  const pending = all(`
    SELECT o.id, o.waybill, o.distance_km, o.delivery_fee, o.total, o.priority, o.is_scheduled, o.scheduled_for,
           c.slug AS category_slug, c.name_en AS category_en, c.name_ar AS category_ar,
           m.business_name AS merchant_name
    FROM orders o
    JOIN categories c ON c.id = o.category_id
    LEFT JOIN merchants m ON m.id = o.merchant_id
    WHERE o.status = 'pending' ORDER BY o.priority DESC, o.id ASC LIMIT 30`);
  const pickupOf = (id) => get("SELECT address, district, lat, lng FROM order_stops WHERE order_id = ? AND kind = 'pickup' AND seq = 1", id);
  const jobs = pending
    .map((o) => {
      const p = pickupOf(o.id);
      const elig = driverEligible(req.user.id, { id: o.id, category_id: get('SELECT category_id FROM orders WHERE id = ?', o.id).category_id, vehicle_id: me.vehicle_id });
      return {
        ...o,
        pickup: p,
        distanceToPickupKm: p ? Math.round(haversineKm(me.lat || 21.5, me.lng || 39.2, p.lat, p.lng) * 10) / 10 : null,
        eligible: elig.ok,
        ineligibleReason: elig.reason || null,
      };
    })
    .filter((j) => j.eligible);
  res.json(jobs);
});

driverRoutes.post('/driver/jobs/:id/accept', requireAuth('driver'), (req, res) => {
  try {
    const updated = transition(Number(req.params.id), 'accepted', req.user, 'accepted by driver');
    res.json(updated);
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

driverRoutes.post('/driver/jobs/:id/reject', requireAuth('driver'), (req, res) => {
  try {
    const o = get('SELECT * FROM orders WHERE id = ?', Number(req.params.id));
    if (!o) return res.status(404).json({ error: 'order not found' });
    if (o.driver_id !== req.user.id) return res.status(403).json({ error: 'not offered to you' });
    const updated = transition(o.id, 'pending', req.user, 'driver rejected — re-dispatching');
    emitToAdmins('order:redispatch', { orderId: o.id });
    res.json({ ok: true, reDispatch: autoDispatch(o.id) });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ---------- Active job ----------
driverRoutes.get('/driver/jobs/active', requireAuth('driver'), (req, res) => {
  const rows = all(`SELECT o.id FROM orders o WHERE o.driver_id = ?
    AND o.status IN ('assigned','accepted','en_route_pickup','at_pickup','loading','in_transit','at_dropoff')`, req.user.id);
  res.json(rows.map((r) => get('SELECT id FROM orders WHERE id = ?', r.id)).map((r) => ({ orderId: r.id })));
});

// ---------- Location stream (powers live customer tracking) ----------
driverRoutes.post('/driver/location', requireAuth('driver'), (req, res) => {
  const { lat, lng } = req.body || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return res.status(400).json({ error: 'lat and lng required' });
  run(`UPDATE driver_profiles SET lat = ?, lng = ?, location_at = datetime('now') WHERE user_id = ?`, lat, lng, req.user.id);
  run('INSERT INTO driver_locations (driver_id, order_id, lat, lng) VALUES (?, ?, ?, ?)',
    req.user.id, Number(req.body.orderId) || null, lat, lng);
  const active = get(`SELECT id, customer_id FROM orders WHERE driver_id = ?
    AND status IN ('accepted','en_route_pickup','in_transit','at_dropoff')`, req.user.id);
  if (active) {
    emitToUser(active.customer_id, 'driver:location', { orderId: active.id, lat, lng, at: new Date().toISOString() });
    broadcastOrder(active.id, 'driver:location', { orderId: active.id, lat, lng });
  }
  res.json({ ok: true });
});

// ---------- Earnings ----------
driverRoutes.get('/driver/earnings', requireAuth('driver'), (req, res) => {
  const today = get(`SELECT COUNT(*) jobs, COALESCE(SUM(delivery_fee),0) gross FROM orders
    WHERE driver_id = ? AND status = 'delivered' AND date(created_at) = date('now')`, req.user.id);
  const week = get(`SELECT COUNT(*) jobs, COALESCE(SUM(delivery_fee),0) gross FROM orders
    WHERE driver_id = ? AND status = 'delivered' AND created_at >= datetime('now','-7 days')`, req.user.id);
  const month = get(`SELECT COUNT(*) jobs, COALESCE(SUM(delivery_fee),0) gross FROM orders
    WHERE driver_id = ? AND status = 'delivered' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')`, req.user.id);
  const settlements = all('SELECT * FROM driver_settlements WHERE driver_id = ? ORDER BY period DESC', req.user.id);
  res.json({ today, week, month, commissionPct: 30, settlements, currency: 'SAR' });
});

// ---------- Incident / damage report ----------
driverRoutes.post('/driver/incidents', requireAuth('driver'), (req, res) => {
  const orderId = Number(req.body?.orderId);
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return res.status(404).json({ error: 'order not found' });
  const kind = ['damage', 'refund', 'complaint'].includes(req.body?.kind) ? req.body.kind : 'damage';
  const cid = run(`INSERT INTO claims (order_id, opened_by, kind, description) VALUES (?, ?, ?, ?)`,
    orderId, req.user.id, kind, String(req.body.description || '').slice(0, 1000)).lastInsertRowid;
  audit(req.user.id, 'incident.report', 'claims', cid, { orderId, kind });
  emitToAdmins('claim:new', { claimId: cid, orderId, kind });
  res.status(201).json({ claimId: cid });
});
