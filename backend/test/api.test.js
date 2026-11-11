// Fiasta API test suite — run: npm test (server must NOT be running; tests boot their own instance)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createServer } from 'node:http';

let server, base, adminToken, custToken, drvToken;

const req = async (path, opts = {}, token) => {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
};

before(async () => {
  openDb(':memory:');
  const app = createApp();
  server = createServer(app);
  await new Promise((ok) => server.listen(0, ok));
  base = `http://localhost:${server.address().port}`;
  // seed via internal seed module
  const { seed } = await import('../src/seed.js');
  seed();
});

after(() => server.close());

const getOtp = async (phone) => {
  const r = await req('/api/auth/otp/request', { method: 'POST', body: { phone } });
  return r.data.debugCode;
};
const login = async (phone) => {
  const code = await getOtp(phone);
  const r = await req('/api/auth/otp/verify', { method: 'POST', body: { phone, code } });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.token;
};

test('health', async () => {
  const r = await req('/health');
  assert.equal(r.data.app, 'fiasta');
});

test('catalog: 7 categories, LPG disabled', async () => {
  const r = await req('/api/categories?lang=en');
  assert.equal(r.data.length, 7);
  const lpg = r.data.find((c) => c.slug === 'lpg');
  assert.equal(lpg.state, 'disabled');
});

test('auth: OTP login works, invalid code rejected', async () => {
  const bad = await req('/api/auth/otp/verify', { method: 'POST', body: { phone: '+966555000111', code: '000000' } });
  assert.equal(bad.status, 401);
  custToken = await login('+966555000111');
  adminToken = await login('+966500000000');
  drvToken = await login('+966555100001');
});

test('quote: minimum fee SAR 50 enforced', async () => {
  const r = await req('/api/quote', { method: 'POST', body: {
    pickup: { lat: 21.562, lng: 39.172 }, dropoffs: [{ lat: 21.565, lng: 39.174 }],
    items: [{ size_tier: 'standard', qty: 1 }],
  } }, custToken);
  assert.ok(r.data.deliveryFee >= 50, `fee ${r.data.deliveryFee} < 50`);
  assert.equal(r.data.currency, 'SAR');
});

test('order: create furniture order with bulky item + helper', async () => {
  const r = await req('/api/orders', { method: 'POST', body: {
    categorySlug: 'furniture',
    pickup: { address: 'Al Andalus', lat: 21.618, lng: 39.208 },
    dropoffs: [{ address: 'Al Rawdah', lat: 21.562, lng: 39.172 }],
    items: [{ name: 'Wardrobe', qty: 1, size_tier: 'extra_bulky', est_weight_kg: 120, est_volume_m3: 3.5 }],
    helpers: 1, paymentMethod: 'cash',
  } }, custToken);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.match(r.data.waybill, /^FIA-\d{6}-\d{4}$/);
  assert.ok(r.data.total > 100);
  assert.equal(r.data.status, 'assigned'); // auto-dispatched
});

test('LPG gate: disabled category refuses orders', async () => {
  const r = await req('/api/orders', { method: 'POST', body: {
    categorySlug: 'lpg',
    pickup: { address: 'x', lat: 21.5, lng: 39.1 },
    dropoffs: [{ address: 'y', lat: 21.5, lng: 39.2 }],
    items: [{ name: 'cylinder', qty: 1 }],
  } }, custToken);
  assert.equal(r.status, 403);
  assert.match(r.data.error, /disabled/);
});

test('vehicle capacity: overweight load refused', async () => {
  const r = await req('/api/orders', { method: 'POST', body: {
    categorySlug: 'business',
    pickup: { address: 'x', lat: 21.5, lng: 39.1 },
    dropoffs: [{ address: 'y', lat: 21.5, lng: 39.2 }],
    items: [{ name: 'pallets', qty: 3, size_tier: 'bulky', est_weight_kg: 900, est_volume_m3: 6 }],
  } }, custToken);
  assert.equal(r.status, 422);
  assert.match(r.data.error, /exceeds/);
});

test('driver: state machine transitions + illegal jump rejected', async () => {
  const list = await req('/api/orders', {}, custToken);
  const order = list.data.find((o) => o.status === 'assigned');
  assert.ok(order, 'no assigned order found');
  // driver is a different user than the assigned one for order 1; use assigned driver +966555100002
  const drv2 = await login('+966555100002');
  const jump = await req(`/api/orders/${order.id}/state`, { method: 'POST', body: { status: 'delivered' } }, drv2);
  assert.equal(jump.status, 409);
  const ok = await req(`/api/orders/${order.id}/state`, { method: 'POST', body: { status: 'accepted' } }, drv2);
  assert.equal(ok.status, 200);
  const enroute = await req(`/api/orders/${order.id}/state`, { method: 'POST', body: { status: 'en_route_pickup' } }, drv2);
  assert.equal(enroute.status, 200);
});

test('public tracking by waybill', async () => {
  const list = await req('/api/orders', {}, custToken);
  const wb = list.data[0].waybill;
  const r = await req('/api/track/' + wb);
  assert.equal(r.status, 200);
  assert.equal(r.data.waybill, wb);
});

test('RBAC: customer cannot access admin endpoints', async () => {
  const r = await req('/api/admin/stats', {}, custToken);
  assert.equal(r.status, 403);
});

test('admin: stats + pricing update is live', async () => {
  const s = await req('/api/admin/stats', {}, adminToken);
  assert.ok(s.data.fleet.length >= 6);
  const put = await req('/api/admin/pricing/min_fee', { method: 'PUT', body: { value: 60 } }, adminToken);
  assert.equal(put.status, 200);
  const q = await req('/api/quote', { method: 'POST', body: {
    pickup: { lat: 21.562, lng: 39.172 }, dropoffs: [{ lat: 21.565, lng: 39.174 }],
    items: [{ size_tier: 'standard', qty: 1 }],
  } }, custToken);
  assert.ok(q.data.deliveryFee >= 60, 'new min fee not applied');
  await req('/api/admin/pricing/min_fee', { method: 'PUT', body: { value: 50 } }, adminToken);
});

test('water: stock decrements on order and restores on cancel', async () => {
  const prods = await req('/api/water/products');
  const p = prods.data[0];
  const before = p.stockQty;
  const r = await req('/api/orders', { method: 'POST', body: {
    categorySlug: 'water',
    pickup: { address: 'depot', lat: 21.484, lng: 39.135 },
    dropoffs: [{ address: 'home', lat: 21.562, lng: 39.172 }],
    waterLines: [{ productId: p.id, qty: 3 }],
    paymentMethod: 'cash',
  } }, custToken);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const after = (await req('/api/water/products')).data.find((x) => x.id === p.id).stockQty;
  assert.equal(after, before - 3);
  const cancel = await req(`/api/orders/${r.data.id}/cancel`, { method: 'POST', body: { reason: 'test' } }, custToken);
  assert.equal(cancel.status, 200);
  const restored = (await req('/api/water/products')).data.find((x) => x.id === p.id).stockQty;
  assert.equal(restored, before);
});

test('merchant: CSV import creates orders', async () => {
  await login('+966556200001'); // merchant user exists
  const code = await getOtp('+966556200001');
  const r = await req('/api/auth/otp/verify', { method: 'POST', body: { phone: '+966556200001', code } });
  const csv = 'pickup_address,pickup_lat,pickup_lng,dropoff_address,dropoff_lat,dropoff_lng,item_name,qty,size_tier,contact_name,contact_phone\n' +
    '"Tahlia St",21.618,39.208,"Al Rawdah",21.562,39.172,Chair,2,standard,Ali,+966555000999';
  const imp = await req('/api/merchant/orders/csv', { method: 'POST', body: { csv } }, r.data.token);
  assert.equal(imp.data.imported, 1, JSON.stringify(imp.data));
});
