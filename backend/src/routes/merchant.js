import { Router } from 'express';
import { all, get, run, tx, audit } from '../db.js';
import { requireAuth } from '../auth.js';
import { createOrder, getOrderFull } from '../orders.js';
import { quote as computeQuote } from '../pricing.js';

export const merchantRoutes = Router();

function merchantOf(userId) {
  return get('SELECT * FROM merchants WHERE user_id = ?', userId);
}

function requireMerchant(req, res, next) {
  const m = merchantOf(req.user.id);
  if (!m) return res.status(403).json({ error: 'not a merchant' });
  req.merchant = m;
  next();
}

merchantRoutes.use('/merchant', requireAuth('merchant', 'admin', 'super_admin'), requireMerchant);

// ---------- Profile & negotiated rates ----------
merchantRoutes.get('/merchant', (req, res) => {
  res.json({ ...req.merchant, rateCard: all('SELECT category_id, discount_pct FROM merchant_rates WHERE merchant_id = ?', req.merchant.id) });
});

merchantRoutes.get('/merchant/orders', (req, res) => {
  const rows = all(`SELECT o.id, o.waybill, o.status, o.total, o.created_at, c.slug AS category_slug,
    du.name AS driver_name FROM orders o JOIN categories c ON c.id = o.category_id
    LEFT JOIN users du ON du.id = o.driver_id WHERE o.merchant_id = ? ORDER BY o.id DESC LIMIT 200`, req.merchant.id);
  res.json(rows);
});

merchantRoutes.get('/merchant/orders/:id', (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o || o.merchant_id !== req.merchant.id) return res.status(404).json({ error: 'order not found' });
  res.json(o);
});

// ---------- Bulk booking: array of orders in one call ----------
merchantRoutes.post('/merchant/orders/bulk', (req, res) => {
  if (req.merchant.status !== 'approved') return res.status(403).json({ error: 'merchant account not approved yet' });
  const list = Array.isArray(req.body?.orders) ? req.body.orders : [];
  if (!list.length) return res.status(400).json({ error: 'orders[] required' });
  const results = [];
  for (const b of list.slice(0, 100)) {
    try {
      const oid = createOrder({ ...b, merchantId: req.merchant.id, paymentMethod: 'merchant_account' }, req.user);
      results.push({ ok: true, orderId: oid, waybill: get('SELECT waybill FROM orders WHERE id = ?', oid).waybill });
    } catch (err) {
      results.push({ ok: false, error: err.message, input: b.reference || null });
    }
  }
  audit(req.user.id, 'merchant.bulk', 'orders', null, { count: results.filter((r) => r.ok).length });
  res.status(201).json({ created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});

// ---------- CSV import ----------
// Expected header: pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,
//                  item_name,qty,size_tier,contact_name,contact_phone
merchantRoutes.post('/merchant/orders/csv', (req, res) => {
  if (req.merchant.status !== 'approved') return res.status(403).json({ error: 'merchant account not approved yet' });
  const csv = String(req.body?.csv || '').trim();
  if (!csv) return res.status(400).json({ error: 'csv content required' });
  const lines = csv.split(/\r?\n/).filter((l) => l.trim());
  const parseLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = parseLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name) => header.indexOf(name);
  if (idx('pickup_address') < 0 || idx('dropoff_address') < 0) {
    return res.status(400).json({ error: 'CSV must include pickup_address and dropoff_address columns' });
  }
  const results = [];
  for (const line of lines.slice(1)) {
    const c = parseLine(line);
    const val = (name) => c[idx(name)];
    try {
      const oid = createOrder({
        categorySlug: val('category') || 'retail',
        pickup: { address: val('pickup_address'), lat: Number(val('pickup_lat')), lng: Number(val('pickup_lng')), contactName: val('contact_name') || '', contactPhone: val('contact_phone') || '' },
        dropoffs: [{ address: val('dropoff_address'), lat: Number(val('dropoff_lat')), lng: Number(val('dropoff_lng')), contactName: val('contact_name') || '', contactPhone: val('contact_phone') || '' }],
        items: [{ name: val('item_name') || 'Carton', qty: Number(val('qty')) || 1, size_tier: val('size_tier') || 'standard' }],
        merchantId: req.merchant.id,
        paymentMethod: 'merchant_account',
        autoDispatch: false,
      }, req.user);
      results.push({ ok: true, orderId: oid, waybill: get('SELECT waybill FROM orders WHERE id = ?', oid).waybill });
    } catch (err) {
      results.push({ ok: false, error: err.message, line });
    }
  }
  audit(req.user.id, 'merchant.csv', 'orders', null, { imported: results.filter((r) => r.ok).length });
  res.status(201).json({ imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results });
});

// ---------- Address book ----------
merchantRoutes.get('/merchant/addresses', (req, res) => {
  res.json(all('SELECT * FROM addresses WHERE user_id = ? AND owner_type = ? ORDER BY id DESC', req.user.id, 'merchant'));
});

merchantRoutes.post('/merchant/addresses', (req, res) => {
  const b = req.body || {};
  if (!b.address || !Number.isFinite(b.lat)) return res.status(400).json({ error: 'address, lat, lng required' });
  const r = run(`INSERT INTO addresses (user_id, owner_type, label, contact_name, contact_phone, district, address, lat, lng)
    VALUES (?, 'merchant', ?, ?, ?, ?, ?, ?, ?)`,
  req.user.id, String(b.label || '').slice(0, 40), String(b.contactName || '').slice(0, 80),
  String(b.contactPhone || '').slice(0, 20), String(b.district || '').slice(0, 60), b.address.trim(), b.lat, b.lng);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ---------- Water supplier: product & stock management ----------
merchantRoutes.get('/merchant/water/products', (req, res) => {
  res.json(all('SELECT * FROM water_products WHERE merchant_id = ? ORDER BY id', req.merchant.id));
});

merchantRoutes.post('/merchant/water/products', (req, res) => {
  const b = req.body || {};
  if (!b.brandEn || !b.sizeLabel) return res.status(400).json({ error: 'brandEn and sizeLabel required' });
  const r = run(`INSERT INTO water_products (merchant_id, brand_en, brand_ar, size_label, unit_price, stock_qty)
    VALUES (?, ?, ?, ?, ?, ?)`,
  req.merchant.id, String(b.brandEn).slice(0, 60), String(b.brandAr || b.brandEn).slice(0, 60),
  String(b.sizeLabel).slice(0, 40), Math.max(0, Number(b.unitPrice) || 0), Math.max(0, Number(b.stockQty) || 0));
  audit(req.user.id, 'water.product.create', 'water_products', r.lastInsertRowid);
  res.status(201).json({ id: r.lastInsertRowid });
});

merchantRoutes.patch('/merchant/water/products/:id', (req, res) => {
  const p = get('SELECT * FROM water_products WHERE id = ? AND merchant_id = ?', req.params.id, req.merchant.id);
  if (!p) return res.status(404).json({ error: 'product not found' });
  const b = req.body || {};
  const price = b.unitPrice != null ? Math.max(0, Number(b.unitPrice)) : p.unit_price;
  const stock = b.stockQty != null ? Math.max(0, Number(b.stockQty)) : p.stock_qty;
  const active = b.active != null ? (b.active ? 1 : 0) : p.active;
  run('UPDATE water_products SET unit_price = ?, stock_qty = ?, active = ? WHERE id = ?', price, stock, active, p.id);
  if (stock !== p.stock_qty) {
    run('INSERT INTO water_stock_moves (product_id, delta, reason) VALUES (?, ?, ?)', p.id, stock - p.stock_qty, 'manual');
  }
  audit(req.user.id, 'water.product.update', 'water_products', p.id, { price, stock, active });
  res.json(get('SELECT * FROM water_products WHERE id = ?', p.id));
});

merchantRoutes.get('/merchant/water/stock-moves', (req, res) => {
  res.json(all(`SELECT sm.*, w.brand_en, w.size_label FROM water_stock_moves sm
    JOIN water_products w ON w.id = sm.product_id WHERE w.merchant_id = ? ORDER BY sm.id DESC LIMIT 100`, req.merchant.id));
});

// ---------- Invoices ----------
merchantRoutes.get('/merchant/invoices', (req, res) => {
  const invoices = all('SELECT * FROM invoices WHERE merchant_id = ? ORDER BY id DESC', req.merchant.id);
  res.json(invoices.map((i) => ({ ...i, lines: all('SELECT * FROM invoice_lines WHERE invoice_id = ?', i.id) })));
});

// ---------- POD download (JSON bundle; PDF generated client-side) ----------
merchantRoutes.get('/merchant/orders/:id/pod', (req, res) => {
  const o = getOrderFull(req.params.id);
  if (!o || o.merchant_id !== req.merchant.id) return res.status(404).json({ error: 'order not found' });
  res.json({ waybill: o.waybill, pod: o.pod, events: o.events, deliveredAt: o.pod?.delivered_at || null });
});
