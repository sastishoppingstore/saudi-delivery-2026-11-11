import { Router } from 'express';
import { config } from './config.js';
import { all, get, run } from './db.js';
import { normalizePhone, requestOtp, verifyOtp, signToken, requireAuth } from './auth.js';
import {
  createOrder, getOrder, transition, nearbyPendingOrders, ordersForUser, orderEvents,
} from './orders.js';
import { emitToUser, broadcastOrder, emitToDrivers, emitToAdmins } from './realtime.js';
import { quote as quoteFor } from './pricing.js';

export const api = Router();

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isPoint = (p) => p && typeof p.address === 'string' && p.address.trim() && isNum(p.lat) && isNum(p.lng)
  && p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180;

function notify(userId, title, body) {
  run('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)', userId, title, body);
  emitToUser(userId, 'notification', { title, body });
}

// ---------- Auth ----------
api.post('/auth/otp/request', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid Saudi mobile number' });
  res.json(requestOtp(phone));
});

api.post('/auth/otp/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone || !req.body?.code) return res.status(400).json({ error: 'phone and code required' });
  if (!verifyOtp(phone, req.body.code)) return res.status(401).json({ error: 'invalid or expired code' });

  let user = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) {
    const role = config.adminPhones.includes(phone) ? 'admin' : 'customer';
    const name = typeof req.body.name === 'string' ? req.body.name.slice(0, 80) : '';
    const r = run('INSERT INTO users (phone, name, role) VALUES (?, ?, ?)', phone, name, role);
    user = get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  }
  if (!user.active) return res.status(403).json({ error: 'account disabled' });
  res.json({ token: signToken(user.id, user.role), user: publicUser(user) });
});

// Drivers register with their details; an admin approves them before they can take orders.
api.post('/auth/driver/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid Saudi mobile number' });
  if (!verifyOtp(phone, req.body?.code)) return res.status(401).json({ error: 'invalid or expired code' });
  const existing = get('SELECT id, role FROM users WHERE phone = ?', phone);
  if (existing && existing.role !== 'driver') return res.status(409).json({ error: 'phone already used' });
  const vehicle = ['bike', 'car', 'van'].includes(req.body.vehicleType) ? req.body.vehicleType : 'car';
  const name = String(req.body.name || '').slice(0, 80);
  const plate = String(req.body.plate || '').slice(0, 20);
  let id = existing?.id;
  if (!id) id = run("INSERT INTO users (phone, name, role) VALUES (?, ?, 'driver')", phone, name).lastInsertRowid;
  run(`INSERT INTO driver_profiles (user_id, vehicle_type, plate) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET vehicle_type = excluded.vehicle_type, plate = excluded.plate`,
  id, vehicle, plate);
  emitToAdmins('driver:pending', { id });
  res.status(201).json({ message: 'registered, waiting for admin approval' });
});

// ---------- Me ----------
api.get('/me', requireAuth(), (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  const profile = req.user.role === 'driver'
    ? get('SELECT vehicle_type, plate, approved, availability FROM driver_profiles WHERE user_id = ?', req.user.id)
    : null;
  res.json({ user: publicUser(user), driver: profile });
});

api.patch('/me', requireAuth(), (req, res) => {
  const name = String(req.body?.name || '').slice(0, 80);
  run('UPDATE users SET name = ? WHERE id = ?', name, req.user.id);
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

api.get('/notifications', requireAuth(), (req, res) => {
  res.json(all('SELECT id, title, body, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id));
});

// ---------- Addresses (customer) ----------
api.get('/addresses', requireAuth('customer'), (req, res) => {
  res.json(all('SELECT id, label, address, lat, lng FROM addresses WHERE user_id = ? ORDER BY id DESC', req.user.id));
});

api.post('/addresses', requireAuth('customer'), (req, res) => {
  if (!isPoint(req.body)) return res.status(400).json({ error: 'address, lat, lng required' });
  const r = run('INSERT INTO addresses (user_id, label, address, lat, lng) VALUES (?, ?, ?, ?, ?)',
    req.user.id, String(req.body.label || '').slice(0, 40), req.body.address.trim(), req.body.lat, req.body.lng);
  res.status(201).json({ id: r.lastInsertRowid });
});

api.delete('/addresses/:id', requireAuth('customer'), (req, res) => {
  run('DELETE FROM addresses WHERE id = ? AND user_id = ?', req.params.id, req.user.id);
  res.status(204).end();
});

// ---------- Orders ----------
api.post('/orders/quote', requireAuth('customer'), (req, res) => {
  const { pickup, dropoff } = req.body || {};
  if (!isPoint(pickup) || !isPoint(dropoff)) return res.status(400).json({ error: 'pickup and dropoff required' });
  res.json(quoteFor(pickup, dropoff));
});

api.post('/orders', requireAuth('customer'), (req, res) => {
  const { pickup, dropoff, paymentMethod } = req.body || {};
  if (!isPoint(pickup) || !isPoint(dropoff)) return res.status(400).json({ error: 'pickup and dropoff required' });
  if (paymentMethod && !['cash', 'card'].includes(paymentMethod)) return res.status(400).json({ error: 'invalid paymentMethod' });
  const order = createOrder(req.user, { ...req.body, pickup, dropoff });
  emitToDrivers('order:new', order);
  emitToAdmins('order:new', order);
  res.status(201).json(order);
});

api.get('/orders', requireAuth(), (req, res) => {
  res.json(ordersForUser(req.user));
});

api.get('/orders/:id', requireAuth(), (req, res) => {
  const order = getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'order not found' });
  const allowed = req.user.role === 'admin'
    || order.customer_id === req.user.id || order.driver_id === req.user.id;
  if (!allowed) return res.status(403).json({ error: 'forbidden' });
  res.json({ ...order, events: orderEvents(order.id) });
});

api.post('/orders/:id/cancel', requireAuth('customer', 'admin'), (req, res) => {
  const result = transition(req.params.id, 'cancelled', req.user, String(req.body?.reason || '').slice(0, 200));
  if (result.error) return res.status(result.code).json({ error: result.error });
  broadcastOrder(result.order);
  notifyParties(result.order, 'cancelled');
  res.json(result.order);
});

api.post('/orders/:id/rate', requireAuth('customer'), (req, res) => {
  const rating = Number(req.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'rating 1-5 required' });
  const order = getOrder(req.params.id);
  if (!order || order.customer_id !== req.user.id) return res.status(404).json({ error: 'order not found' });
  if (order.status !== 'delivered') return res.status(409).json({ error: 'only delivered orders can be rated' });
  if (order.rating) return res.status(409).json({ error: 'already rated' });
  run('UPDATE orders SET rating = ?, rating_comment = ? WHERE id = ?', rating,
    String(req.body.comment || '').slice(0, 300), order.id);
  res.json(getOrder(order.id));
});

// ---------- Driver ----------
api.get('/driver/orders/available', requireAuth('driver'), (req, res) => {
  if (!driverCanWork(req.user.id)) return res.status(403).json({ error: 'driver not approved or offline' });
  res.json(nearbyPendingOrders(req.user.id));
});

api.post('/driver/availability', requireAuth('driver'), (req, res) => {
  const status = req.body?.status;
  if (!['online', 'offline'].includes(status)) return res.status(400).json({ error: 'status online|offline' });
  const profile = get('SELECT approved, availability FROM driver_profiles WHERE user_id = ?', req.user.id);
  if (!profile?.approved) return res.status(403).json({ error: 'driver not approved yet' });
  if (profile.availability === 'busy' && status === 'offline') return res.status(409).json({ error: 'finish current order first' });
  run('UPDATE driver_profiles SET availability = ? WHERE user_id = ?', status, req.user.id);
  res.json({ availability: status });
});

api.post('/driver/location', requireAuth('driver'), (req, res) => {
  const { lat, lng } = req.body || {};
  if (!isNum(lat) || !isNum(lng)) return res.status(400).json({ error: 'lat and lng required' });
  run("UPDATE driver_profiles SET lat = ?, lng = ?, location_at = datetime('now') WHERE user_id = ?", lat, lng, req.user.id);
  // Stream the position to the customer of the driver's active order.
  const active = get("SELECT id, customer_id FROM orders WHERE driver_id = ? AND status IN ('assigned','picked_up')", req.user.id);
  if (active) emitToUser(active.customer_id, 'driver:location', { orderId: active.id, lat, lng });
  res.json({ ok: true });
});

api.post('/orders/:id/accept', requireAuth('driver'), (req, res) => {
  if (!driverCanWork(req.user.id)) return res.status(403).json({ error: 'driver not approved or offline' });
  const result = transition(req.params.id, 'assigned', req.user, 'accepted by driver');
  if (result.error) return res.status(result.code).json({ error: result.error });
  broadcastOrder(result.order);
  notifyParties(result.order, 'assigned');
  res.json(result.order);
});

api.post('/orders/:id/pickup', requireAuth('driver'), (req, res) => advance(req, res, 'picked_up', 'picked up'));
api.post('/orders/:id/deliver', requireAuth('driver'), (req, res) => advance(req, res, 'delivered', 'delivered'));

function advance(req, res, to, note) {
  const result = transition(req.params.id, to, req.user, note);
  if (result.error) return res.status(result.code).json({ error: result.error });
  broadcastOrder(result.order);
  notifyParties(result.order, to);
  res.json(result.order);
}

function driverCanWork(userId) {
  const p = get('SELECT approved, availability FROM driver_profiles WHERE user_id = ?', userId);
  return Boolean(p?.approved) && p.availability !== 'offline';
}

function notifyParties(order, status) {
  const texts = {
    assigned: ['Driver assigned', 'A driver accepted your order.'],
    picked_up: ['On the way', 'Your order was picked up.'],
    delivered: ['Delivered', 'Your order was delivered. Please rate your driver.'],
    cancelled: ['Order cancelled', 'Your order was cancelled.'],
  };
  const [title, body] = texts[status] || ['Order update', `Status: ${status}`];
  notify(order.customer_id, title, body);
  if (status === 'cancelled' && order.driver_id) notify(order.driver_id, title, 'The order was cancelled.');
}

// ---------- Admin ----------
api.get('/admin/stats', requireAuth('admin'), (req, res) => {
  const byStatus = all('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const revenue = get("SELECT COALESCE(SUM(total),0) AS total FROM orders WHERE payment_status = 'paid'");
  const drivers = get("SELECT COUNT(*) AS n FROM driver_profiles WHERE availability = 'online'");
  res.json({ byStatus, revenue: revenue.total, onlineDrivers: drivers.n, currency: config.currency });
});

api.get('/admin/drivers', requireAuth('admin'), (req, res) => {
  res.json(all(`SELECT u.id, u.name, u.phone, u.active, p.vehicle_type, p.plate, p.approved, p.availability, p.lat, p.lng, p.location_at
                FROM users u JOIN driver_profiles p ON p.user_id = u.id ORDER BY u.id DESC`));
});

api.post('/admin/drivers/:id/approve', requireAuth('admin'), (req, res) => {
  const approved = req.body?.approved === false ? 0 : 1;
  const r = run('UPDATE driver_profiles SET approved = ?, availability = CASE WHEN ? = 0 THEN \'offline\' ELSE availability END WHERE user_id = ?',
    approved, approved, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'driver not found' });
  notify(Number(req.params.id), approved ? 'Account approved' : 'Account not approved',
    approved ? 'You can now go online and accept orders.' : 'Please contact support.');
  res.json({ approved: Boolean(approved) });
});

api.post('/admin/users/:id/active', requireAuth('admin'), (req, res) => {
  const active = req.body?.active ? 1 : 0;
  const r = run('UPDATE users SET active = ? WHERE id = ? AND role != \'admin\'', active, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'user not found' });
  res.json({ active: Boolean(active) });
});

api.get('/admin/users', requireAuth('admin'), (req, res) => {
  res.json(all('SELECT id, name, phone, role, active, created_at FROM users ORDER BY id DESC LIMIT 500'));
});

// ---------- helpers ----------
function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, role: u.role };
}
