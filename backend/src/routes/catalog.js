import { Router } from 'express';
import { all, get } from '../db.js';
import { requireAuth } from '../auth.js';

export const catalogRoutes = Router();

const LANG = (req) => (req.query.lang === 'en' ? 'en' : req.query.lang === 'ar' ? 'ar' : null);

/** Public category catalogue. States are visible so apps can show "coming soon" tiles. */
catalogRoutes.get('/categories', (req, res) => {
  const l = LANG(req);
  const rows = all('SELECT * FROM categories ORDER BY sort_order');
  res.json(rows.map((c) => ({
    id: c.id,
    slug: c.slug,
    name: l === 'en' ? c.name_en : l === 'ar' ? c.name_ar : { en: c.name_en, ar: c.name_ar },
    description: l === 'en' ? c.desc_en : l === 'ar' ? c.desc_ar : { en: c.desc_en, ar: c.desc_ar },
    icon: c.icon,
    state: c.state,
    requiresHelpers: !!c.requires_helpers,
  })));
});

catalogRoutes.get('/categories/:slug/items', (req, res) => {
  const l = LANG(req);
  const cat = get('SELECT * FROM categories WHERE slug = ? OR id = ?', req.params.slug, req.params.slug);
  if (!cat) return res.status(404).json({ error: 'category not found' });
  const items = all('SELECT * FROM category_items WHERE category_id = ? AND active = 1 ORDER BY id', cat.id);
  res.json(items.map((i) => ({
    id: i.id,
    name: l === 'en' ? i.name_en : l === 'ar' ? i.name_ar : { en: i.name_en, ar: i.name_ar },
    sizeTier: i.size_tier,
    estWeightKg: i.est_weight_kg,
    estVolumeM3: i.est_volume_m3,
  })));
});

/** Water supplier catalog (public read; stock managed by merchant/admin). */
catalogRoutes.get('/water/products', (req, res) => {
  const l = LANG(req);
  const rows = all(`SELECT w.*, m.business_name FROM water_products w
    JOIN merchants m ON m.id = w.merchant_id WHERE w.active = 1 ORDER BY w.id`);
  res.json(rows.map((w) => ({
    id: w.id,
    brand: l === 'en' ? w.brand_en : l === 'ar' ? w.brand_ar : { en: w.brand_en, ar: w.brand_ar },
    sizeLabel: w.size_label,
    unitPrice: w.unit_price,
    stockQty: w.stock_qty,
    supplier: w.business_name,
    merchantId: w.merchant_id,
  })));
});

/** Public zone list (Jeddah districts) for the address picker. */
catalogRoutes.get('/zones', (req, res) => {
  const l = LANG(req);
  const rows = all('SELECT * FROM zones WHERE active = 1 ORDER BY name_en');
  res.json(rows.map((z) => ({
    id: z.id,
    name: l === 'en' ? z.name_en : l === 'ar' ? z.name_ar : { en: z.name_en, ar: z.name_ar },
    lat: z.lat, lng: z.lng, radiusKm: z.radius_km, surcharge: z.surcharge,
  })));
});

/** Promo validation (pre-checkout). */
catalogRoutes.post('/promos/validate', requireAuth('customer', 'merchant'), (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase();
  const p = get("SELECT * FROM promos WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))", code);
  if (!p) return res.status(404).json({ error: 'promo code not valid' });
  if (p.max_uses != null && p.used_count >= p.max_uses) return res.status(409).json({ error: 'promo code fully used' });
  res.json({ code: p.code, kind: p.kind, value: p.value, minOrder: p.min_order });
});
