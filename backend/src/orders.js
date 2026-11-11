import { all, get, run, tx, audit } from './db.js';
import { haversineKm, quote as computeQuote, suitableVehicleClasses } from './pricing.js';
import { emitToUser, broadcastOrder, emitToDrivers, emitToAdmins } from './realtime.js';
import { config } from './config.js';

const round2 = (n) => Math.round(n * 100) / 100;

export const ORDER_STATES = [
  'pending', 'assigned', 'accepted', 'en_route_pickup', 'at_pickup',
  'loading', 'in_transit', 'at_dropoff', 'delivered', 'cancelled', 'failed',
];

// Which transitions are legal (driver/customer/admin rules enforced in transition()).
const TRANSITIONS = {
  pending: ['assigned', 'cancelled'],
  assigned: ['accepted', 'pending', 'cancelled'],   // driver rejects → back to pending
  accepted: ['en_route_pickup', 'cancelled', 'failed'],
  en_route_pickup: ['at_pickup', 'failed'],
  at_pickup: ['loading', 'failed'],
  loading: ['in_transit', 'failed'],
  in_transit: ['at_dropoff', 'failed'],
  at_dropoff: ['delivered', 'failed'],
  delivered: [],
  cancelled: [],
  failed: [],
};

export function nextWaybill() {
  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const row = get("SELECT COUNT(*) c FROM orders WHERE waybill LIKE ?", `FIA-${ymd}-%`);
  return `FIA-${ymd}-${String((row?.c || 0) + 1).padStart(4, '0')}`;
}

function notify(userId, title, body) {
  if (!userId) return;
  run('INSERT INTO notifications (user_id, title, body) VALUES (?, ?, ?)', userId, title, body);
  emitToUser(userId, 'notification', { title, body });
}

/**
 * Validate + price a new order request. Throws on validation errors.
 * Returns { order, stops, items, quote }.
 */
export function validateOrderInput(body, user) {
  const cat = get('SELECT * FROM categories WHERE id = ? OR slug = ?',
    body.categoryId ?? null, (body.categorySlug || body.categoryId) ?? null);
  if (!cat) throw Object.assign(new Error('unknown category'), { status: 400 });

  // Category state gate — the server, not the client, decides what can be ordered.
  if (cat.state === 'disabled') throw Object.assign(new Error(`category '${cat.slug}' is currently disabled`), { status: 403 });
  if (cat.state === 'partner_only' || cat.state === 'compliance_approved') {
    const merch = body.merchantId
      ? get("SELECT * FROM merchants WHERE id = ? AND status = 'approved' AND category_id = ?", body.merchantId, cat.id)
      : null;
    if (!merch) throw Object.assign(new Error(`category '${cat.slug}' can only be ordered through an approved partner`), { status: 403 });
  }

  const pickup = body.pickup;
  if (!pickup?.address || !Number.isFinite(pickup?.lat)) throw Object.assign(new Error('pickup location required'), { status: 400 });
  const dropoffs = (body.dropoffs || [body.dropoff]).filter(Boolean);
  if (!dropoffs.length) throw Object.assign(new Error('at least one drop-off required'), { status: 400 });
  for (const p of [pickup, ...dropoffs]) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 90 || Math.abs(p.lng) > 180) {
      throw Object.assign(new Error('invalid coordinates'), { status: 400 });
    }
  }

  const items = (body.items || []).map((i) => ({
    name: String(i.name || 'item').slice(0, 120),
    qty: Math.max(1, Math.min(500, Number(i.qty) || 1)),
    size_tier: ['standard', 'bulky', 'extra_bulky'].includes(i.size_tier) ? i.size_tier : 'standard',
    est_weight_kg: Math.max(0, Number(i.est_weight_kg) || 0),
    est_volume_m3: Math.max(0, Number(i.est_volume_m3) || 0),
    width_cm: i.width_cm ? Number(i.width_cm) : null,
    height_cm: i.height_cm ? Number(i.height_cm) : null,
    depth_cm: i.depth_cm ? Number(i.depth_cm) : null,
    note: String(i.note || '').slice(0, 300),
    photo_path: String(i.photo_path || '').slice(0, 300),
    category_item_id: i.category_item_id || null,
  }));
  if (!items.length && !(body.waterLines || []).length) {
    throw Object.assign(new Error('at least one item required'), { status: 400 });
  }

  // Water quantity comes from the supplier catalog
  let waterUnits = 0;
  if (cat.slug === 'water') {
    for (const it of body.waterLines || []) {
      const prod = get('SELECT * FROM water_products WHERE id = ? AND active = 1', it.productId);
      if (!prod) throw Object.assign(new Error('unknown water product'), { status: 400 });
      if (prod.stock_qty < it.qty) throw Object.assign(new Error(`insufficient stock for ${prod.brand_en} ${prod.size_label}`), { status: 409 });
      waterUnits += it.qty;
    }
    if (!waterUnits) throw Object.assign(new Error('select water products'), { status: 400 });
  }

  // Vehicle payload/size enforcement
  const fit = suitableVehicleClasses(items);
  if (!fit.fits) {
    throw Object.assign(
      new Error(`load of ~${Math.round(fit.weight)} kg / ${fit.volume.toFixed(1)} m³ exceeds our largest vehicle — split the order or request a custom quote`),
      { status: 422 },
    );
  }

  // LPG hard gate: only an approved partner merchant + compliant driver+vehicle may ever touch LPG.
  if (cat.slug === 'lpg') {
    if (cat.state !== 'compliance_approved') {
      throw Object.assign(new Error('LPG delivery is locked until compliance documents are verified by admin'), { status: 423 });
    }
    if (!body.merchantId) throw Object.assign(new Error('LPG orders require an approved gas distributor'), { status: 403 });
  }

  const helpers = Math.max(0, Math.min(3, Number(body.helpers) || 0));
  const floors = { pickup: Number(body.floorPickup) || 0, dropoff: Number(body.floorDropoff) || 0 };
  const elevators = { pickup: !!body.elevatorPickup, dropoff: !!body.elevatorDropoff };
  const priority = body.priority === true || body.priority === 'priority';

  const q = computeQuote({
    pickup,
    stops: dropoffs,
    items,
    helpers,
    floors,
    elevators,
    priority,
    vehicleClass: fit.classes[0],
    zoneSurcharge: zoneSurchargeFor(dropoffs[0]),
    categorySlug: cat.slug,
    waterUnits,
  });

  // Promo
  let promo = null;
  if (body.promoCode) {
    const p = get("SELECT * FROM promos WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))", body.promoCode);
    if (p && q.deliveryFee + q.waterCost >= p.min_order && (p.max_uses == null || p.used_count < p.max_uses)) {
      const disc = p.kind === 'percent' ? round2((q.deliveryFee + q.waterCost) * p.value / 100) : Math.min(p.value, q.deliveryFee);
      q.lines.push({ label: `Promo ${p.code}`, amount: -disc, note: '' });
      q.deliveryFee = round2(Math.max(config.pricing.minFee, q.deliveryFee - disc));
      q.total = round2(q.deliveryFee + q.waterCost + q.vat);
      promo = p;
    }
  }

  return { cat, items, pickup, dropoffs, helpers, floors, elevators, priority, q, promo, waterUnits, fit };
}

function zoneSurchargeFor(point) {
  const zones = all('SELECT * FROM zones WHERE active = 1');
  for (const z of zones) {
    if (haversineKm(point.lat, point.lng, z.lat, z.lng) <= z.radius_km) return z.surcharge;
  }
  return 0;
}

export function createOrder(body, user) {
  return tx(() => {
    const v = validateOrderInput(body, user);
    const { cat, items, pickup, dropoffs, helpers, floors, elevators, priority, q, promo, waterUnits } = v;
    const scheduledFor = body.scheduledFor || null;
    const isScheduled = !!scheduledFor;

    const oid = run(`INSERT INTO orders (waybill, customer_id, merchant_id, category_id, status, is_scheduled, scheduled_for,
        priority, payment_method, distance_km, delivery_fee, vat, total, price_breakdown, needs_helpers, helpers_count,
        floor_pickup, elevator_pickup, floor_dropoff, elevator_dropoff, photos_json)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    nextWaybill(), user.id, body.merchantId || null, cat.id, isScheduled ? 1 : 0, scheduledFor,
    priority ? 'priority' : 'standard',
    ['cash', 'card', 'merchant_account'].includes(body.paymentMethod) ? body.paymentMethod : 'cash',
    q.distanceKm, q.deliveryFee, q.vat, q.total, JSON.stringify(q.lines),
    helpers > 0 ? 1 : 0, helpers,
    floors.pickup, elevators.pickup ? 1 : 0, floors.dropoff, elevators.dropoff ? 1 : 0,
    JSON.stringify(items.map((i) => i.photo_path).filter(Boolean)),
    ).lastInsertRowid;

    run(`INSERT INTO order_stops (order_id, kind, seq, address, district, lat, lng, contact_name, contact_phone, notes)
         VALUES (?, 'pickup', 1, ?, ?, ?, ?, ?, ?, ?)`,
    oid, pickup.address, pickup.district || '', pickup.lat, pickup.lng,
    pickup.contactName || user.name, pickup.contactPhone || user.phone, pickup.notes || '');
    dropoffs.forEach((d, i) => {
      run(`INSERT INTO order_stops (order_id, kind, seq, address, district, lat, lng, contact_name, contact_phone, notes)
           VALUES (?, 'dropoff', ?, ?, ?, ?, ?, ?, ?, ?)`,
      oid, i + 1, d.address, d.district || '', d.lat, d.lng, d.contactName || '', d.contactPhone || '', d.notes || '');
    });

    for (const it of items) {
      run(`INSERT INTO order_items (order_id, category_item_id, name, qty, size_tier, est_weight_kg, est_volume_m3,
            width_cm, height_cm, depth_cm, photo_path, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      oid, it.category_item_id, it.name, it.qty, it.size_tier, it.est_weight_kg, it.est_volume_m3,
      it.width_cm, it.height_cm, it.depth_cm, it.photo_path, it.note);
    }

    // Water stock moves
    if (waterUnits > 0) {
      for (const wl of body.waterLines || []) {
        const prod = get('SELECT * FROM water_products WHERE id = ?', wl.productId);
        const lineTotal = round2(prod.unit_price * wl.qty);
        run(`INSERT INTO order_items (order_id, name, qty, size_tier, est_weight_kg, est_volume_m3, note)
             VALUES (?, ?, ?, 'standard', 0, 0, ?)`,
        oid, `${prod.brand_en} ${prod.size_label}`, wl.qty, `water product#${prod.id} — SAR ${lineTotal}`);
        run('UPDATE water_products SET stock_qty = stock_qty - ? WHERE id = ?', wl.qty, prod.id);
        run('INSERT INTO water_stock_moves (product_id, delta, reason, order_id) VALUES (?, ?, ?, ?)',
          prod.id, -wl.qty, 'order', oid);
      }
    }

    if (promo) run('UPDATE promos SET used_count = used_count + 1 WHERE id = ?', promo.id);

    run('INSERT INTO order_events (order_id, status, actor_id, note) VALUES (?, ?, ?, ?)',
      oid, 'pending', user.id, isScheduled ? `Scheduled order for ${scheduledFor}` : 'Order created — awaiting dispatch');
    run('INSERT INTO payments (order_id, provider, amount, status) VALUES (?, ?, ?, ?)',
      oid, body.paymentMethod === 'card' ? 'mock' : 'cod', q.total, body.paymentMethod === 'card' ? 'captured' : 'pending');

    audit(user.id, 'order.create', 'orders', oid, { waybill: get('SELECT waybill FROM orders WHERE id = ?', oid).waybill, category: cat.slug });
    return oid;
  });
}

export function getOrderFull(id) {
  const o = get(`
    SELECT o.*, c.slug AS category_slug, c.name_en AS category_en, c.name_ar AS category_ar,
           u.name AS customer_name, u.phone AS customer_phone,
           m.business_name AS merchant_name,
           du.name AS driver_name, du.phone AS driver_phone,
           v.plate AS vehicle_plate, v.model AS vehicle_model, v.class AS vehicle_class
    FROM orders o
    JOIN categories c ON c.id = o.category_id
    LEFT JOIN users u ON u.id = o.customer_id
    LEFT JOIN users du ON du.id = o.driver_id
    LEFT JOIN merchants m ON m.id = o.merchant_id
    LEFT JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.id = ?`, id);
  if (!o) return null;
  o.stops = all('SELECT * FROM order_stops WHERE order_id = ? ORDER BY kind DESC, seq', id);
  o.items = all('SELECT * FROM order_items WHERE order_id = ?', id);
  o.events = all('SELECT e.*, us.name actor FROM order_events e LEFT JOIN users us ON us.id = e.actor_id WHERE e.order_id = ? ORDER BY e.id', id);
  o.pod = get('SELECT * FROM pod_records WHERE order_id = ?', id) || null;
  o.price_breakdown = JSON.parse(o.price_breakdown || '[]');
  o.photos = JSON.parse(o.photos_json || '[]');
  return o;
}

/** Driver eligibility for an order: category state, LPG compliance, vehicle capacity. */
export function driverEligible(driverId, order) {
  const dp = get('SELECT * FROM driver_profiles WHERE user_id = ?', driverId);
  if (!dp || !dp.approved || dp.availability !== 'online') return { ok: false, reason: 'driver not available' };
  const cat = get('SELECT * FROM categories WHERE id = ?', order.category_id);

  if (cat.slug === 'lpg') {
    const docs = all('SELECT * FROM lpg_compliance WHERE driver_id = ? AND verified = 1', driverId);
    const hasDriverCert = docs.some((d) => d.doc_type === 'driver_cert');
    const veh = get('SELECT * FROM vehicles WHERE id = ?', order.vehicle_id || dp.vehicle_id);
    const vehApproved = veh?.lpg_approved;
    const lic = docs.some((d) => d.doc_type === 'distributor_licence');
    if (!(hasDriverCert && vehApproved && lic)) {
      return { ok: false, reason: 'LPG compliance not verified for this driver/vehicle' };
    }
  }

  const items = all('SELECT * FROM order_items WHERE order_id = ?', order.id);
  const fit = suitableVehicleClasses(items);
  const veh = get('SELECT * FROM vehicles WHERE id = ?', order.vehicle_id || dp.vehicle_id);
  if (veh && (fit.weight > veh.payload_kg || fit.volume > veh.volume_m3)) {
    return { ok: false, reason: `load exceeds ${veh.model} capacity` };
  }
  return { ok: true };
}

export function transition(orderId, next, actor, note = '', gps = null) {
  return tx(() => {
    const o = get('SELECT * FROM orders WHERE id = ?', orderId);
    if (!o) throw Object.assign(new Error('order not found'), { status: 404 });
    if (!TRANSITIONS[o.status]?.includes(next)) {
      throw Object.assign(new Error(`illegal transition ${o.status} → ${next}`), { status: 409 });
    }

    const role = actor.role;
    const driverStates = ['accepted', 'en_route_pickup', 'at_pickup', 'loading', 'in_transit', 'at_dropoff', 'delivered', 'failed'];
    if (driverStates.includes(next) && role !== 'driver' && role !== 'admin' && role !== 'super_admin') {
      throw Object.assign(new Error('only the assigned driver can set this state'), { status: 403 });
    }

    if (next === 'assigned') {
      const dp = get('SELECT * FROM driver_profiles WHERE user_id = ?', actor.id);
      const targetDriver = Number.isFinite(note?.driverId) ? note.driverId : actor.id;
      const target = get('SELECT * FROM driver_profiles WHERE user_id = ?', targetDriver);
      if (!target?.approved) throw Object.assign(new Error('driver not approved'), { status: 403 });
      const eligible = driverEligible(targetDriver, o);
      if (!eligible.ok) throw Object.assign(new Error(eligible.reason), { status: 423 });
      run('UPDATE orders SET driver_id = ?, vehicle_id = ? WHERE id = ?', targetDriver, target.vehicle_id, orderId);
      notify(targetDriver, 'New delivery offer', `Order ${o.waybill} is available to accept.`);
    }

    if (next === 'accepted') {
      if (o.driver_id !== actor.id && role !== 'admin' && role !== 'super_admin') {
        throw Object.assign(new Error('not your order'), { status: 403 });
      }
      run("UPDATE driver_profiles SET availability = 'busy' WHERE user_id = ?", o.driver_id);
      notify(o.customer_id, 'Driver on the way to pickup', `${get('SELECT name FROM users WHERE id = ?', o.driver_id).name} accepted order ${o.waybill}.`);
    }

    if (next === 'pending' && o.status === 'assigned') {
      // driver rejected → free the order for re-dispatch
      run('UPDATE orders SET driver_id = NULL, vehicle_id = NULL WHERE id = ?', orderId);
      emitToAdmins('order:redispatch', { orderId });
    }

    if (next === 'delivered') {
      run("UPDATE driver_profiles SET availability = 'online', total_jobs = total_jobs + 1 WHERE user_id = ?", o.driver_id);
      run("UPDATE payments SET status = 'captured' WHERE order_id = ? AND provider = 'cod'", orderId);
      notify(o.customer_id, 'Delivered', `Order ${o.waybill} was delivered. Rate your experience!`);
    }

    if (next === 'cancelled' || next === 'failed') {
      if (o.driver_id) run("UPDATE driver_profiles SET availability = 'online' WHERE user_id = ?", o.driver_id);
      // restock water
      if (get("SELECT slug FROM categories WHERE id = ?", o.category_id)?.slug === 'water') {
        const lines = all("SELECT * FROM order_items WHERE order_id = ? AND note LIKE 'water product#%'", orderId);
        for (const l of lines) {
          const productId = Number(/water product#(\d+)/.exec(l.note)?.[1]);
          if (!Number.isInteger(productId)) continue;
          run('UPDATE water_products SET stock_qty = stock_qty + ? WHERE id = ?', l.qty, productId);
          run('INSERT INTO water_stock_moves (product_id, delta, reason, order_id) VALUES (?, ?, ?, ?)',
            productId, l.qty, 'cancel', orderId);
        }
      }
    }

    run(`UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`, next, orderId);
    run('INSERT INTO order_events (order_id, status, actor_id, note, lat, lng) VALUES (?, ?, ?, ?, ?, ?)',
      orderId, next, actor.id, typeof note === 'string' ? note : '', gps?.lat ?? null, gps?.lng ?? null);

    audit(actor.id, `order.${next}`, 'orders', orderId, note || '');
    broadcastOrder(orderId, 'order:updated', { orderId, status: next, note });
    return getOrderFull(orderId);
  });
}

/** Auto-dispatch: nearest online eligible driver for a pending order. */
export function autoDispatch(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o || o.status !== 'pending') return { dispatched: false, reason: 'order not dispatchable' };
  const pickup = get("SELECT * FROM order_stops WHERE order_id = ? AND kind = 'pickup'", orderId);
  const candidates = all(`
    SELECT dp.user_id, dp.lat, dp.lng FROM driver_profiles dp
    JOIN users u ON u.id = dp.user_id
    WHERE dp.approved = 1 AND dp.availability = 'online' AND u.active = 1`);
  const eligible = candidates
    .map((c) => ({ ...c, dist: pickup ? haversineKm(pickup.lat, pickup.lng, c.lat || 0, c.lng || 0) : 999 }))
    .filter((c) => driverEligible(c.user_id, o).ok && c.dist <= config.dispatchRadiusKm)
    .sort((a, b) => a.dist - b.dist);
  if (!eligible.length) return { dispatched: false, reason: 'no eligible driver nearby' };
  const sys = { id: null, role: 'admin' };
  transition(orderId, 'assigned', { ...sys, id: eligible[0].user_id }, `auto-dispatch: ${eligible[0].dist.toFixed(1)} km from pickup`);
  return { dispatched: true, driverId: eligible[0].user_id, distanceKm: round2(eligible[0].dist) };
}

export function ordersForUser(userId, role) {
  const base = `SELECT o.id, o.waybill, o.status, o.total, o.created_at, o.scheduled_for, o.is_scheduled,
    c.name_en AS category_en, c.name_ar AS category_ar, c.slug AS category_slug,
    du.name AS driver_name, m.business_name
    FROM orders o JOIN categories c ON c.id = o.category_id
    LEFT JOIN users du ON du.id = o.driver_id
    LEFT JOIN merchants m ON m.id = o.merchant_id`;
  if (role === 'driver') return all(`${base} WHERE o.driver_id = ? ORDER BY o.id DESC LIMIT 100`, userId);
  return all(`${base} WHERE o.customer_id = ? ORDER BY o.id DESC LIMIT 100`, userId);
}
