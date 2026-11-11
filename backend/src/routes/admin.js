import { Router } from 'express';
import { all, get, run, tx, audit } from '../db.js';
import { requireAuth } from '../auth.js';
import { transition, autoDispatch, getOrderFull, driverEligible } from '../orders.js';
import { getPricing, setPricing, PRICING_DEFAULTS } from '../pricing.js';
import { emitToUser, emitToDrivers, emitToAdmins } from '../realtime.js';
import { config } from '../config.js';

export const adminRoutes = Router();

const isAdmin = requireAuth('admin', 'super_admin');
const isSuper = requireAuth('super_admin');

// ---------- Dashboard KPIs ----------
adminRoutes.get('/admin/stats', isAdmin, (req, res) => {
  const byStatus = all('SELECT status, COUNT(*) n FROM orders GROUP BY status');
  const revenue = get("SELECT COALESCE(SUM(total),0) t FROM orders WHERE payment_status = 'paid'");
  const pending = get("SELECT COUNT(*) n FROM orders WHERE status = 'pending'").n;
  const onlineDrivers = get("SELECT COUNT(*) n FROM driver_profiles WHERE availability = 'online'").n;
  const today = get("SELECT COUNT(*) n, COALESCE(SUM(total),0) rev FROM orders WHERE date(created_at) = date('now')");
  const topCategories = all(`SELECT c.name_en, c.name_ar, COUNT(o.id) n FROM orders o
    JOIN categories c ON c.id = o.category_id GROUP BY c.id ORDER BY n DESC`);
  const fleet = all(`SELECT v.*, du.name driver_name, dp.availability FROM vehicles v
    LEFT JOIN driver_profiles dp ON dp.vehicle_id = v.id LEFT JOIN users du ON du.id = dp.user_id`);
  res.json({ byStatus, revenue: revenue.t, pending, onlineDrivers, today, topCategories, fleet, currency: config.currency });
});

// ---------- Live fleet ----------
adminRoutes.get('/admin/fleet', isAdmin, (req, res) => {
  res.json(all(`SELECT u.id, u.name, u.phone, dp.availability, dp.lat, dp.lng, dp.location_at, dp.rating,
    v.plate, v.model, v.class, v.payload_kg, v.volume_m3, v.lpg_approved,
    (SELECT COUNT(*) FROM orders o WHERE o.driver_id = u.id AND o.status NOT IN ('delivered','cancelled','failed')) active_jobs
    FROM driver_profiles dp JOIN users u ON u.id = dp.user_id LEFT JOIN vehicles v ON v.id = dp.vehicle_id`));
});

// ---------- Users ----------
adminRoutes.get('/admin/users', isAdmin, (req, res) => {
  const role = req.query.role;
  res.json(role
    ? all('SELECT id, name, phone, role, active, created_at FROM users WHERE role = ? ORDER BY id DESC LIMIT 500', role)
    : all('SELECT id, name, phone, role, active, created_at FROM users ORDER BY id DESC LIMIT 500'));
});

adminRoutes.post('/admin/users/:id/active', isAdmin, (req, res) => {
  const active = req.body?.active ? 1 : 0;
  const r = run("UPDATE users SET active = ? WHERE id = ? AND role NOT IN ('admin','super_admin')", active, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'user not found' });
  audit(req.user.id, 'user.active', 'users', req.params.id, { active });
  res.json({ active: Boolean(active) });
});

// ---------- Drivers & vehicles ----------
adminRoutes.get('/admin/drivers', isAdmin, (req, res) => {
  res.json(all(`SELECT u.id, u.name, u.phone, u.active, dp.vehicle_id, dp.license_no, dp.national_id,
    dp.approved, dp.availability, dp.lat, dp.lng, dp.rating, dp.total_jobs, dp.lpg_certified, v.plate, v.model
    FROM users u JOIN driver_profiles dp ON dp.user_id = u.id LEFT JOIN vehicles v ON v.id = dp.vehicle_id
    ORDER BY u.id DESC`));
});

adminRoutes.post('/admin/drivers/:id/approve', isAdmin, (req, res) => {
  const approved = req.body?.approved === false ? 0 : 1;
  const r = run(`UPDATE driver_profiles SET approved = ?,
    availability = CASE WHEN ? = 0 THEN 'offline' ELSE availability END WHERE user_id = ?`, approved, approved, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'driver not found' });
  emitToUser(Number(req.params.id), 'notification', {
    title: approved ? 'Account approved' : 'Account suspended',
    body: approved ? 'You can now go online and accept orders.' : 'Please contact support.',
  });
  audit(req.user.id, 'driver.approve', 'users', req.params.id, { approved });
  res.json({ approved: Boolean(approved) });
});

adminRoutes.post('/admin/drivers/:id/assign-vehicle', isAdmin, (req, res) => {
  const vehicleId = Number(req.body?.vehicleId);
  const v = get('SELECT * FROM vehicles WHERE id = ?', vehicleId);
  if (!v) return res.status(404).json({ error: 'vehicle not found' });
  run('UPDATE driver_profiles SET vehicle_id = ? WHERE user_id = ?', vehicleId, req.params.id);
  audit(req.user.id, 'driver.assign_vehicle', 'users', req.params.id, { vehicleId, plate: v.plate });
  res.json({ ok: true });
});

adminRoutes.get('/admin/vehicles', isAdmin, (req, res) => res.json(all('SELECT * FROM vehicles ORDER BY id')));

adminRoutes.post('/admin/vehicles', isAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.plate || !b.model) return res.status(400).json({ error: 'plate and model required' });
  const cls = ['hiace', 'hiace_high_roof', 'box_truck'].includes(b.class) ? b.class : 'hiace';
  const r = run(`INSERT INTO vehicles (plate, model, class, payload_kg, volume_m3, lpg_approved)
    VALUES (?, ?, ?, ?, ?, ?)`,
  String(b.plate).slice(0, 20), String(b.model).slice(0, 80), cls,
  Math.max(1, Number(b.payloadKg) || 900), Math.max(0.5, Number(b.volumeM3) || 7.8), b.lpgApproved ? 1 : 0);
  audit(req.user.id, 'vehicle.create', 'vehicles', r.lastInsertRowid, b);
  res.status(201).json(get('SELECT * FROM vehicles WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.patch('/admin/vehicles/:id', isAdmin, (req, res) => {
  const v = get('SELECT * FROM vehicles WHERE id = ?', req.params.id);
  if (!v) return res.status(404).json({ error: 'vehicle not found' });
  const b = req.body || {};
  run('UPDATE vehicles SET lpg_approved = ?, active = ?, payload_kg = ?, volume_m3 = ? WHERE id = ?',
    b.lpgApproved != null ? (b.lpgApproved ? 1 : 0) : v.lpg_approved,
    b.active != null ? (b.active ? 1 : 0) : v.active,
    b.payloadKg != null ? Number(b.payloadKg) : v.payload_kg,
    b.volumeM3 != null ? Number(b.volumeM3) : v.volume_m3,
    v.id);
  audit(req.user.id, 'vehicle.update', 'vehicles', v.id, b);
  res.json(get('SELECT * FROM vehicles WHERE id = ?', v.id));
});

// ---------- Categories & items (everything configurable) ----------
adminRoutes.get('/admin/categories', isAdmin, (req, res) => res.json(all('SELECT * FROM categories ORDER BY sort_order')));

adminRoutes.post('/admin/categories', isAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.slug || !b.nameEn || !b.nameAr) return res.status(400).json({ error: 'slug, nameEn, nameAr required' });
  const state = ['active', 'disabled', 'partner_only', 'compliance_approved'].includes(b.state) ? b.state : 'disabled';
  const r = run(`INSERT INTO categories (slug, name_en, name_ar, desc_en, desc_ar, icon, state, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  String(b.slug).toLowerCase().replace(/[^a-z0-9-]/g, ''), String(b.nameEn).slice(0, 80), String(b.nameAr).slice(0, 80),
  String(b.descEn || ''), String(b.descAr || ''), String(b.icon || 'box'), state, Number(b.sortOrder) || 100);
  audit(req.user.id, 'category.create', 'categories', r.lastInsertRowid, b);
  res.status(201).json(get('SELECT * FROM categories WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.patch('/admin/categories/:id', isAdmin, (req, res) => {
  const c = get('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'category not found' });
  const b = req.body || {};
  const state = ['active', 'disabled', 'partner_only', 'compliance_approved'].includes(b.state) ? b.state : c.state;
  // LPG safety gate: cannot go active without verified compliance rows
  if (c.slug === 'lpg' && state === 'active') {
    const verified = all('SELECT doc_type FROM lpg_compliance WHERE verified = 1').map((r) => r.doc_type);
    const needed = ['distributor_licence', 'vehicle_approval', 'driver_cert'];
    if (!needed.every((d) => verified.includes(d))) {
      return res.status(423).json({ error: 'LPG cannot be activated: verify distributor licence, vehicle approval and driver certificate first', missing: needed.filter((d) => !verified.includes(d)) });
    }
  }
  run(`UPDATE categories SET state = ?, name_en = COALESCE(?, name_en), name_ar = COALESCE(?, name_ar),
    desc_en = COALESCE(?, desc_en), desc_ar = COALESCE(?, desc_ar), sort_order = COALESCE(?, sort_order) WHERE id = ?`,
  state, b.nameEn ?? null, b.nameAr ?? null, b.descEn ?? null, b.descAr ?? null,
  b.sortOrder != null ? Number(b.sortOrder) : null, c.id);
  audit(req.user.id, 'category.update', 'categories', c.id, { state, from: c.state });
  emitToAdmins('category:updated', { id: c.id, state });
  res.json(get('SELECT * FROM categories WHERE id = ?', c.id));
});

adminRoutes.post('/admin/categories/:id/items', isAdmin, (req, res) => {
  const c = get('SELECT * FROM categories WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'category not found' });
  const b = req.body || {};
  if (!b.nameEn || !b.nameAr) return res.status(400).json({ error: 'nameEn and nameAr required' });
  const tier = ['standard', 'bulky', 'extra_bulky'].includes(b.sizeTier) ? b.sizeTier : 'standard';
  const r = run(`INSERT INTO category_items (category_id, name_en, name_ar, size_tier, est_weight_kg, est_volume_m3)
    VALUES (?, ?, ?, ?, ?, ?)`,
  c.id, String(b.nameEn).slice(0, 80), String(b.nameAr).slice(0, 80), tier,
  Math.max(0, Number(b.estWeightKg) || 0), Math.max(0, Number(b.estVolumeM3) || 0));
  audit(req.user.id, 'category_item.create', 'category_items', r.lastInsertRowid);
  res.status(201).json(get('SELECT * FROM category_items WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.patch('/admin/items/:id', isAdmin, (req, res) => {
  const it = get('SELECT * FROM category_items WHERE id = ?', req.params.id);
  if (!it) return res.status(404).json({ error: 'item not found' });
  const b = req.body || {};
  run('UPDATE category_items SET active = ?, size_tier = COALESCE(?, size_tier) WHERE id = ?',
    b.active != null ? (b.active ? 1 : 0) : it.active,
    ['standard', 'bulky', 'extra_bulky'].includes(b.sizeTier) ? b.sizeTier : null, it.id);
  res.json(get('SELECT * FROM category_items WHERE id = ?', it.id));
});

// ---------- Pricing engine ----------
adminRoutes.get('/admin/pricing', isAdmin, (req, res) => {
  const rows = all('SELECT * FROM pricing_config');
  res.json({ config: rows.length ? rows : Object.entries(PRICING_DEFAULTS).map(([key, v]) => ({ key, value: v.value, label: v.label })) });
});

adminRoutes.put('/admin/pricing/:key', isAdmin, (req, res) => {
  try {
    setPricing(req.params.key, req.body?.value);
    audit(req.user.id, 'pricing.update', 'pricing_config', null, { key: req.params.key, value: req.body?.value });
    res.json({ key: req.params.key, value: req.body?.value });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---------- Zones ----------
adminRoutes.get('/admin/zones', isAdmin, (req, res) => res.json(all('SELECT * FROM zones ORDER BY name_en')));

adminRoutes.post('/admin/zones', isAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.nameEn || !Number.isFinite(b.lat)) return res.status(400).json({ error: 'nameEn, lat, lng required' });
  const r = run('INSERT INTO zones (name_en, name_ar, lat, lng, radius_km, surcharge) VALUES (?, ?, ?, ?, ?, ?)',
    String(b.nameEn).slice(0, 60), String(b.nameAr || b.nameEn).slice(0, 60), b.lat, b.lng,
    Math.max(0.5, Number(b.radiusKm) || 4), Math.max(0, Number(b.surcharge) || 0));
  audit(req.user.id, 'zone.create', 'zones', r.lastInsertRowid);
  res.status(201).json(get('SELECT * FROM zones WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.patch('/admin/zones/:id', isAdmin, (req, res) => {
  const z = get('SELECT * FROM zones WHERE id = ?', req.params.id);
  if (!z) return res.status(404).json({ error: 'zone not found' });
  const b = req.body || {};
  run('UPDATE zones SET surcharge = ?, active = ?, radius_km = ? WHERE id = ?',
    b.surcharge != null ? Number(b.surcharge) : z.surcharge,
    b.active != null ? (b.active ? 1 : 0) : z.active,
    b.radiusKm != null ? Number(b.radiusKm) : z.radius_km, z.id);
  audit(req.user.id, 'zone.update', 'zones', z.id, b);
  res.json(get('SELECT * FROM zones WHERE id = ?', z.id));
});

// ---------- Merchants ----------
adminRoutes.get('/admin/merchants', isAdmin, (req, res) => {
  res.json(all(`SELECT m.*, u.name contact_name, u.phone, c.slug category_slug FROM merchants m
    JOIN users u ON u.id = m.user_id LEFT JOIN categories c ON c.id = m.category_id ORDER BY m.id DESC`));
});

adminRoutes.post('/admin/merchants/:id/status', isAdmin, (req, res) => {
  const status = ['pending', 'approved', 'suspended'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status pending|approved|suspended' });
  const m = get('SELECT * FROM merchants WHERE id = ?', req.params.id);
  if (!m) return res.status(404).json({ error: 'merchant not found' });
  run('UPDATE merchants SET status = ?, negotiated_discount_pct = ? WHERE id = ?',
    status, req.body?.discountPct != null ? Number(req.body.discountPct) : m.negotiated_discount_pct, m.id);
  emitToUser(m.user_id, 'notification', { title: 'Merchant account update', body: `Your account is now ${status}.` });
  audit(req.user.id, 'merchant.status', 'merchants', m.id, { status });
  res.json({ ok: true });
});

// ---------- Dispatch ----------
adminRoutes.get('/admin/dispatch/pending', isAdmin, (req, res) => {
  const rows = all(`SELECT o.id, o.waybill, o.status, o.priority, o.created_at, o.total, c.slug category_slug,
    (SELECT address FROM order_stops s WHERE s.order_id = o.id AND s.kind = 'pickup' LIMIT 1) pickup
    FROM orders o JOIN categories c ON c.id = o.category_id WHERE o.status = 'pending' ORDER BY o.priority DESC, o.id`);
  res.json(rows.map((o) => ({ ...o, eligibleDrivers: all(`SELECT u.id, u.name, dp.lat, dp.lng FROM driver_profiles dp
    JOIN users u ON u.id = dp.user_id WHERE dp.approved = 1 AND dp.availability = 'online'`)
    .map((d) => ({ ...d, eligible: driverEligible(d.id, { id: o.id, category_id: get('SELECT category_id FROM orders WHERE id = ?', o.id).category_id }).ok })) })));
});

adminRoutes.post('/admin/dispatch/:orderId', isAdmin, (req, res) => {
  const o = get('SELECT * FROM orders WHERE id = ?', req.params.orderId);
  if (!o) return res.status(404).json({ error: 'order not found' });
  try {
    if (req.body?.driverId) {
      const driver = get('SELECT * FROM users WHERE id = ? AND role = ?', req.body.driverId, 'driver');
      if (!driver) return res.status(404).json({ error: 'driver not found' });
      const updated = transition(o.id, 'assigned', { ...req.user, id: Number(req.body.driverId) }, `manually dispatched by ${req.user.name}`);
      return res.json(updated);
    }
    const r = autoDispatch(o.id);
    if (!r.dispatched) return res.status(409).json({ error: r.reason });
    res.json(getOrderFull(o.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// ---------- Orders overview ----------
adminRoutes.get('/admin/orders', isAdmin, (req, res) => {
  const status = req.query.status;
  res.json(status
    ? all(`SELECT o.id, o.waybill, o.status, o.total, o.created_at, o.payment_status, c.slug category_slug,
        u.name customer_name, du.name driver_name FROM orders o JOIN categories c ON c.id = o.category_id
        LEFT JOIN users u ON u.id = o.customer_id LEFT JOIN users du ON du.id = o.driver_id
        WHERE o.status = ? ORDER BY o.id DESC LIMIT 300`, status)
    : all(`SELECT o.id, o.waybill, o.status, o.total, o.created_at, o.payment_status, c.slug category_slug,
        u.name customer_name, du.name driver_name FROM orders o JOIN categories c ON c.id = o.category_id
        LEFT JOIN users u ON u.id = o.customer_id LEFT JOIN users du ON du.id = o.driver_id
        ORDER BY o.id DESC LIMIT 300`));
});

adminRoutes.get('/admin/orders/:id', isAdmin, (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o) return res.status(404).json({ error: 'order not found' });
  res.json(o);
});

// ---------- LPG compliance ----------
adminRoutes.get('/admin/lpg/compliance', isAdmin, (req, res) => {
  res.json(all(`SELECT lc.*, u.name driver_name, v.plate, v.model FROM lpg_compliance lc
    JOIN users u ON u.id = lc.driver_id JOIN vehicles v ON v.id = lc.vehicle_id ORDER BY lc.id`));
});

adminRoutes.post('/admin/lpg/compliance', isAdmin, (req, res) => {
  const b = req.body || {};
  const driverId = Number(b.driverId);
  const vehicleId = Number(b.vehicleId);
  if (!Number.isInteger(driverId) || !Number.isInteger(vehicleId) || !b.docType) {
    return res.status(400).json({ error: 'driverId, vehicleId, docType required' });
  }
  if (!['distributor_licence', 'vehicle_approval', 'driver_cert', 'insurance'].includes(b.docType)) {
    return res.status(400).json({ error: 'docType must be distributor_licence | vehicle_approval | driver_cert | insurance' });
  }
  const r = run(`INSERT INTO lpg_compliance (driver_id, vehicle_id, doc_type, doc_ref, verified) VALUES (?, ?, ?, ?, 0)
    ON CONFLICT(driver_id, vehicle_id, doc_type) DO UPDATE SET doc_ref = excluded.doc_ref`,
  driverId, vehicleId, b.docType, String(b.docRef || '').slice(0, 80));
  audit(req.user.id, 'lpg.doc.add', 'lpg_compliance', r.lastInsertRowid, { docType: b.docType });
  res.status(201).json(get('SELECT * FROM lpg_compliance WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.post('/admin/lpg/compliance/:id/verify', isAdmin, (req, res) => {
  const row = get('SELECT * FROM lpg_compliance WHERE id = ?', req.params.id);
  if (!row) return res.status(404).json({ error: 'compliance row not found' });
  const ok = req.body?.verified !== false;
  run(`UPDATE lpg_compliance SET verified = ?, verified_by = ?, verified_at = datetime('now'), expires_at = ? WHERE id = ?`,
    ok ? 1 : 0, req.user.id, req.body?.expiresAt || null, row.id);
  audit(req.user.id, ok ? 'lpg.verify' : 'lpg.revoke', 'lpg_compliance', row.id, { doc: row.doc_type });

  // If every required doc for this driver+vehicle is verified, mark driver + vehicle
  const docs = all('SELECT doc_type, verified FROM lpg_compliance WHERE driver_id = ? AND vehicle_id = ?', row.driver_id, row.vehicle_id);
  const allVerified = ['distributor_licence', 'vehicle_approval', 'driver_cert'].every((t) => docs.some((d) => d.doc_type === t && d.verified));
  if (allVerified) {
    run('UPDATE driver_profiles SET lpg_certified = 1 WHERE user_id = ?', row.driver_id);
    run('UPDATE vehicles SET lpg_approved = 1 WHERE id = ?', row.vehicle_id);
    const cat = get("SELECT * FROM categories WHERE slug = 'lpg'");
    if (cat && cat.state === 'disabled') {
      run("UPDATE categories SET state = 'compliance_approved' WHERE id = ?", cat.id);
      audit(req.user.id, 'lpg.category_enabled', 'categories', cat.id, 'all compliance verified');
    }
  }
  res.json({ ok, allVerified, note: allVerified ? 'driver certified + vehicle approved; LPG category unlocked' : 'awaiting remaining documents' });
});

// ---------- Promos / payments / settlements / invoices / claims / support ----------
adminRoutes.get('/admin/promos', isAdmin, (req, res) => res.json(all('SELECT * FROM promos ORDER BY id DESC')));

adminRoutes.post('/admin/promos', isAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.code) return res.status(400).json({ error: 'code required' });
  const r = run(`INSERT INTO promos (code, kind, value, min_order, max_uses, active, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    String(b.code).toUpperCase().slice(0, 20), b.kind === 'fixed' ? 'fixed' : 'percent',
    Math.max(0, Number(b.value) || 0), Math.max(0, Number(b.minOrder) || 0),
    b.maxUses ? Number(b.maxUses) : null, b.active === false ? 0 : 1, b.expiresAt || null);
  audit(req.user.id, 'promo.create', 'promos', r.lastInsertRowid);
  res.status(201).json(get('SELECT * FROM promos WHERE id = ?', r.lastInsertRowid));
});

adminRoutes.get('/admin/payments', isAdmin, (req, res) => {
  res.json(all(`SELECT p.*, o.waybill FROM payments p JOIN orders o ON o.id = p.order_id ORDER BY p.id DESC LIMIT 300`));
});

adminRoutes.post('/admin/payments/:id/reconcile', isAdmin, (req, res) => {
  const status = ['captured', 'failed', 'refunded'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'status captured|failed|refunded' });
  run('UPDATE payments SET status = ? WHERE id = ?', status, req.params.id);
  audit(req.user.id, 'payment.reconcile', 'payments', req.params.id, { status });
  res.json({ ok: true });
});

adminRoutes.get('/admin/settlements', isAdmin, (req, res) => {
  res.json(all(`SELECT ds.*, u.name driver_name FROM driver_settlements ds JOIN users u ON u.id = ds.driver_id ORDER BY ds.period DESC`));
});

adminRoutes.post('/admin/settlements/generate', isAdmin, (req, res) => {
  const period = String(req.body?.period || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (!period) return res.status(400).json({ error: 'period YYYY-MM required' });
  const drivers = all(`SELECT driver_id, COUNT(*) jobs, COALESCE(SUM(delivery_fee),0) gross FROM orders
    WHERE status = 'delivered' AND strftime('%Y-%m', created_at) = ? AND driver_id IS NOT NULL GROUP BY driver_id`, period);
  for (const d of drivers) {
    run(`INSERT INTO driver_settlements (driver_id, period, jobs, gross, commission_pct, payout, status)
      VALUES (?, ?, ?, ?, 30, ?, 'pending')
      ON CONFLICT(driver_id, period) DO UPDATE SET jobs = excluded.jobs, gross = excluded.gross, payout = excluded.payout`,
    d.driver_id, period, d.jobs, d.gross, Math.round(d.gross * 0.7 * 100) / 100);
  }
  audit(req.user.id, 'settlements.generate', 'driver_settlements', null, { period, drivers: drivers.length });
  res.json({ period, settlements: drivers.length });
});

adminRoutes.post('/admin/settlements/:id/pay', isAdmin, (req, res) => {
  run("UPDATE driver_settlements SET status = 'paid' WHERE id = ?", req.params.id);
  audit(req.user.id, 'settlement.pay', 'driver_settlements', req.params.id);
  res.json({ ok: true });
});

adminRoutes.get('/admin/invoices', isAdmin, (req, res) => {
  res.json(all(`SELECT i.*, m.business_name FROM invoices i LEFT JOIN merchants m ON m.id = i.merchant_id ORDER BY i.id DESC`));
});

adminRoutes.post('/admin/invoices/generate', isAdmin, (req, res) => {
  const period = String(req.body?.period || '').match(/^\d{4}-\d{2}$/)?.[0];
  if (!period) return res.status(400).json({ error: 'period YYYY-MM required' });
  const merchants = all('SELECT id FROM merchants');
  const created = [];
  for (const m of merchants) {
    const agg = get(`SELECT COUNT(*) jobs, COALESCE(SUM(delivery_fee),0) sub FROM orders
      WHERE merchant_id = ? AND status = 'delivered' AND strftime('%Y-%m', created_at) = ?`, m.id, period);
    if (!agg.jobs) continue;
    const vat = Math.round(agg.sub * 0.15 * 100) / 100;
    const num = `INV-${period.replace('-', '')}-${String(m.id).padStart(4, '0')}`;
    const existing = get('SELECT id FROM invoices WHERE number = ?', num);
    const iid = existing ? existing.id : run(`INSERT INTO invoices (number, merchant_id, period, subtotal, vat, total, status)
      VALUES (?, ?, ?, ?, ?, ?, 'issued')`, num, m.id, period, agg.sub, vat, Math.round((agg.sub + vat) * 100) / 100).lastInsertRowid;
    if (!existing) run('INSERT INTO invoice_lines (invoice_id, description, amount) VALUES (?, ?, ?)', iid, `${agg.jobs} delivered orders — ${period}`, agg.sub);
    created.push(num);
  }
  audit(req.user.id, 'invoices.generate', 'invoices', null, { period, created });
  res.json({ period, created });
});

adminRoutes.get('/admin/claims', isAdmin, (req, res) => {
  res.json(all(`SELECT cl.*, o.waybill, u.name opened_by_name FROM claims cl
    JOIN orders o ON o.id = cl.order_id JOIN users u ON u.id = cl.opened_by ORDER BY cl.id DESC`));
});

adminRoutes.post('/admin/claims/:id', isAdmin, (req, res) => {
  const status = ['open', 'investigating', 'resolved', 'rejected'].includes(req.body?.status) ? req.body.status : null;
  if (!status) return res.status(400).json({ error: 'invalid status' });
  run('UPDATE claims SET status = ?, resolution = ?, amount = ? WHERE id = ?',
    status, String(req.body?.resolution || '').slice(0, 500), Math.max(0, Number(req.body?.amount) || 0), req.params.id);
  audit(req.user.id, 'claim.update', 'claims', req.params.id, { status });
  res.json({ ok: true });
});

adminRoutes.get('/admin/support', isAdmin, (req, res) => {
  res.json(all(`SELECT t.*, u.name user_name, u.phone FROM support_tickets t JOIN users u ON u.id = t.user_id ORDER BY t.id DESC`));
});

adminRoutes.post('/admin/support/:id/reply', isAdmin, (req, res) => {
  const t = get('SELECT * FROM support_tickets WHERE id = ?', req.params.id);
  if (!t) return res.status(404).json({ error: 'ticket not found' });
  run("UPDATE support_tickets SET reply = ?, status = 'answered' WHERE id = ?", String(req.body?.reply || '').slice(0, 1000), t.id);
  emitToUser(t.user_id, 'notification', { title: 'Support reply', body: String(req.body?.reply || '').slice(0, 120) });
  audit(req.user.id, 'support.reply', 'support_tickets', t.id);
  res.json({ ok: true });
});

// ---------- Water products (admin override) ----------
adminRoutes.get('/admin/water/products', isAdmin, (req, res) => {
  res.json(all(`SELECT w.*, m.business_name FROM water_products w JOIN merchants m ON m.id = w.merchant_id ORDER BY w.id`));
});

// ---------- Reports / CSV export ----------
adminRoutes.get('/admin/reports/orders.csv', isAdmin, (req, res) => {
  const rows = all(`SELECT o.id, o.waybill, o.status, o.created_at, o.distance_km, o.delivery_fee, o.vat, o.total,
    o.payment_method, o.payment_status, c.slug category, u.name customer, du.name driver
    FROM orders o JOIN categories c ON c.id = o.category_id
    LEFT JOIN users u ON u.id = o.customer_id LEFT JOIN users du ON du.id = o.driver_id ORDER BY o.id`);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = 'id,waybill,status,created_at,distance_km,delivery_fee,vat,total,payment_method,payment_status,category,customer,driver';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="fiasta-orders.csv"');
  res.send([head, ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n'));
});

adminRoutes.get('/admin/reports/settlements.csv', isAdmin, (req, res) => {
  const rows = all(`SELECT ds.*, u.name driver_name, u.phone FROM driver_settlements ds JOIN users u ON u.id = ds.driver_id ORDER BY ds.period DESC`);
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.send(['driver,phone,period,jobs,gross,commission_pct,payout,status',
    ...rows.map((r) => [r.driver_name, r.phone, r.period, r.jobs, r.gross, r.commission_pct, r.payout, r.status].map(esc).join(','))].join('\n'));
});

// ---------- Audit log ----------
adminRoutes.get('/admin/audit', isAdmin, (req, res) => {
  res.json(all(`SELECT a.*, u.name actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 300`));
});

// ---------- Super admin: manage admins ----------
adminRoutes.post('/admin/admins', isSuper, (req, res) => {
  const phone = String(req.body?.phone || '');
  const u = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!u) return res.status(404).json({ error: 'user not found — they must log in once first' });
  run("UPDATE users SET role = 'admin' WHERE id = ?", u.id);
  audit(req.user.id, 'admin.promote', 'users', u.id);
  res.json({ ok: true });
});
