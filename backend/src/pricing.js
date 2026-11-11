import { all, get, run } from './db.js';
import { config } from './config.js';

const round2 = (n) => Math.round(n * 100) / 100;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Default pricing knobs. Every value is editable via Admin (pricing_config table). */
export const PRICING_DEFAULTS = {
  min_fee: { value: 50, label: 'Minimum delivery fee (SAR)' },
  road_factor: { value: 1.3, label: 'Road factor (straight-line multiplier)' },
  vat_rate: { value: 0.15, label: 'VAT rate (15%)' },
  // Distance bands: [maxKm, feeMin, feeMax]
  band_1: { value: [5, 50, 65], label: '0–5 km (SAR)' },
  band_2: { value: [10, 60, 85], label: '5–10 km (SAR)' },
  band_3: { value: [15, 75, 110], label: '10–15 km (SAR)' },
  band_4: { value: [20, 95, 135], label: '15–20 km (SAR)' },
  band_custom_note: { value: '20+ km requires a custom quotation', label: 'Over-20 km policy' },
  bulky_standard: { value: [80, 130], label: 'Standard bulky item surcharge (SAR)' },
  bulky_extra: { value: [130, 250], label: 'Extra-bulky / multiple bulky items (SAR)' },
  extra_stop: { value: [15, 25], label: 'Extra stop fee (SAR)' },
  extra_helper: { value: [25, 50], label: 'Extra helper fee (SAR)' },
  stairs_per_floor: { value: 8, label: 'Stairs surcharge per floor, no elevator (SAR)' },
  priority_pct: { value: 30, label: 'Priority delivery surcharge (%)' },
  waiting_grace_min: { value: 15, label: 'Free waiting time (minutes)' },
  waiting_per_10min: { value: 10, label: 'Waiting time per 10 min after grace (SAR)' },
  vehicle_multiplier_hiace: { value: 1.0, label: 'Vehicle multiplier — HiAce' },
  vehicle_multiplier_hiace_high_roof: { value: 1.15, label: 'Vehicle multiplier — HiAce high roof' },
  vehicle_multiplier_box_truck: { value: 1.4, label: 'Vehicle multiplier — box truck' },
  water_delivery_fee: { value: 20, label: 'Water delivery fee (SAR, per drop)' },
  water_min_qty: { value: 1, label: 'Minimum water units per order' },
};

export function getPricing() {
  const rows = all('SELECT key, value FROM pricing_config');
  const cfg = {};
  for (const [k, v] of Object.entries(PRICING_DEFAULTS)) cfg[k] = v.value;
  for (const r of rows) {
    try { cfg[r.key] = JSON.parse(r.value); } catch { cfg[r.key] = r.value; }
  }
  return cfg;
}

export function setPricing(key, value) {
  if (!(key in PRICING_DEFAULTS)) throw new Error(`unknown pricing key: ${key}`);
  run(
    `INSERT INTO pricing_config (key, value, label) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key, JSON.stringify(value), PRICING_DEFAULTS[key].label,
  );
}

/** Band fee: interpolate inside [min,max] by position within the band. */
function bandFee(cfg, distanceKm) {
  const bands = [cfg.band_1, cfg.band_2, cfg.band_3, cfg.band_4];
  for (let i = 0; i < bands.length; i++) {
    const [maxKm, fMin, fMax] = bands[i];
    const prevMax = i === 0 ? 0 : bands[i - 1][0];
    if (distanceKm <= maxKm) {
      const t = (distanceKm - prevMax) / (maxKm - prevMax || 1);
      return fMin + (fMax - fMin) * Math.min(1, Math.max(0, t));
    }
  }
  return null; // 20+ km → custom quotation
}

/**
 * Itemised quote. Input:
 *   pickup {lat,lng}, stops [{lat,lng}], items [{size_tier, qty, est_weight_kg, est_volume_m3}],
 *   helpers (count beyond 0), floors {pickup, dropoff}, elevators {pickup, dropoff},
 *   priority bool, vehicleClass, waitingMin, zoneSurcharge, categorySlug
 */
export function quote(input) {
  const cfg = getPricing();
  const {
    pickup, stops = [], items = [], helpers = 0,
    floors = {}, elevators = {}, priority = false,
    vehicleClass = 'hiace', waitingMin = 0, zoneSurcharge = 0, categorySlug = '',
    waterUnits = 0,
  } = input;

  const lines = [];
  const add = (label, amount, note = '') => {
    if (amount > 0) lines.push({ label, amount: round2(amount), note });
    return round2(amount);
  };

  // Route distance: pickup → each stop in sequence
  const points = [pickup, ...stops];
  let distanceKm = 0;
  for (let i = 0; i < points.length - 1; i++) {
    distanceKm += haversineKm(points[i].lat, points[i].lng, points[i + 1].lat, points[i + 1].lng);
  }
  distanceKm = round2(distanceKm * cfg.road_factor);

  const base = bandFee(cfg, distanceKm);
  let customQuote = false;
  if (base === null) {
    customQuote = true;
    lines.push({ label: 'Base delivery (20+ km)', amount: 0, note: cfg.band_custom_note });
  } else {
    add(`Base delivery (${distanceKm} km)`, base);
  }

  // Bulky items
  const bulkyStd = items.filter((i) => i.size_tier === 'bulky').reduce((s, i) => s + (i.qty || 1), 0);
  const bulkyX = items.filter((i) => i.size_tier === 'extra_bulky').reduce((s, i) => s + (i.qty || 1), 0);
  if (bulkyStd > 0) add('Bulky item handling', cfg.bulky_standard[0] + Math.min(bulkyStd - 1, 4) * ((cfg.bulky_standard[1] - cfg.bulky_standard[0]) / 4));
  if (bulkyX > 0) add('Extra-bulky item handling', cfg.bulky_extra[0] + Math.min(bulkyX - 1, 4) * ((cfg.bulky_extra[1] - cfg.bulky_extra[0]) / 4));
  if (bulkyStd + bulkyX >= 3) add('Multiple bulky items', Math.min(bulkyStd + bulkyX - 2, 5) * 20, '3+ bulky pieces');

  // Stops beyond the first dropoff
  const extraStops = Math.max(0, stops.length - 1);
  if (extraStops > 0) add(`Extra stops ×${extraStops}`, extraStops * cfg.extra_stop[0]);

  // Helpers
  if (helpers > 0) add(`Extra helpers ×${helpers}`, helpers * cfg.extra_helper[0]);

  // Stairs (floors without elevator)
  const stairsFloors = (elevators.pickup ? 0 : Math.max(0, (floors.pickup || 0) - 1))
    + (elevators.dropoff ? 0 : Math.max(0, (floors.dropoff || 0) - 1));
  if (stairsFloors > 0) add(`Stairs ×${stairsFloors} floors`, stairsFloors * cfg.stairs_per_floor);

  // Priority
  let subtotal = lines.reduce((s, l) => s + l.amount, 0);
  if (priority && subtotal > 0) {
    const p = round2(subtotal * (cfg.priority_pct / 100));
    lines.push({ label: `Priority surcharge (${cfg.priority_pct}%)`, amount: p, note: '' });
    subtotal += p;
  }

  // Vehicle class multiplier (applies to delivery lines, not water product cost)
  const vMult = cfg[`vehicle_multiplier_${vehicleClass}`] ?? 1;
  if (vMult !== 1 && subtotal > 0) {
    const diff = round2(subtotal * (vMult - 1));
    lines.push({ label: `Vehicle class (${vehicleClass.replace(/_/g, ' ')})`, amount: diff, note: `×${vMult}` });
    subtotal += diff;
  }

  // Zone surcharge
  if (zoneSurcharge > 0) {
    lines.push({ label: 'Zone surcharge', amount: round2(zoneSurcharge), note: '' });
    subtotal += round2(zoneSurcharge);
  }

  // Waiting time
  const waitBillable = Math.max(0, waitingMin - cfg.waiting_grace_min);
  if (waitBillable > 0) add(`Waiting time (${Math.ceil(waitBillable / 10)} × 10 min)`, Math.ceil(waitBillable / 10) * cfg.waiting_per_10min);

  // Water product cost (separate from delivery fee)
  let waterCost = 0;
  if (waterUnits > 0) {
    const unit = get('SELECT MIN(unit_price) p FROM water_products WHERE active = 1');
    waterCost = round2(waterUnits * (unit?.p ?? 0));
    if (waterCost > 0) lines.push({ label: `Water products ×${waterUnits}`, amount: waterCost, note: 'supplier price' });
    add('Water delivery fee', cfg.water_delivery_fee);
    subtotal += waterCost + cfg.water_delivery_fee;
  }

  subtotal = round2(lines.reduce((s, l) => s + l.amount, 0));
  const fee = Math.max(customQuote ? 0 : cfg.min_fee, round2(subtotal - waterCost)); // delivery fee ≥ min fee
  const vat = round2((fee + waterCost) * cfg.vat_rate);
  const total = round2(fee + waterCost + vat);

  return {
    currency: config.currency,
    distanceKm,
    customQuote,
    lines,
    deliveryFee: fee,
    waterCost,
    vat,
    total,
    breakdown: { helpers, stairsFloors, extraStops, priority, vehicleClass },
  };
}

/** Which vehicle classes can carry this load? Enforces payload & volume. */
export function suitableVehicleClasses(items) {
  const weight = items.reduce((s, i) => s + (i.est_weight_kg || 0) * (i.qty || 1), 0);
  const volume = items.reduce((s, i) => s + (i.est_volume_m3 || 0) * (i.qty || 1), 0);
  const classes = [];
  const limits = { hiace: [900, 7.8], hiace_high_roof: [1100, 10.5], box_truck: [2000, 16] };
  for (const [cls, [kg, m3]] of Object.entries(limits)) {
    if (weight <= kg && volume <= m3) classes.push(cls);
  }
  return { weight, volume, classes, fits: classes.length > 0 };
}
