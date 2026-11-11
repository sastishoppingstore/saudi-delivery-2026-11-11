import { run, get, all, tx, audit } from './db.js';
import { PRICING_DEFAULTS } from './pricing.js';

const J = (lat, lng) => ({ lat, lng });

// Real Jeddah district coordinates (approximate centres)
export const DISTRICTS = [
  { name_en: 'Al Rawdah', name_ar: 'الروضة', ...J(21.5620, 39.1720) },
  { name_en: 'Al Salamah', name_ar: 'السلامة', ...J(21.5870, 39.1480) },
  { name_en: 'Al Aziziyah', name_ar: 'العزيزية', ...J(21.5300, 39.2130) },
  { name_en: 'Al Hamra', name_ar: 'الحمراء', ...J(21.5430, 39.1580) },
  { name_en: 'Al Shati', name_ar: 'الشاطىء', ...J(21.6010, 39.1330) },
  { name_en: 'Al Zahra', name_ar: 'الزهراء', ...J(21.6060, 39.1810) },
  { name_en: 'Al Rabwah', name_ar: 'الرواة', ...J(21.5390, 39.1900) },
  { name_en: 'Al Bawadi', name_ar: 'البوادي', ...J(21.5210, 39.1660) },
  { name_en: 'Al Safa', name_ar: 'الصفا', ...J(21.5480, 39.1990) },
  { name_en: 'Al Naeem', name_ar: 'النعيم', ...J(21.5140, 39.1860) },
  { name_en: 'Al Faisaliyah', name_ar: 'الفلسطينية', ...J(21.6240, 39.1600) }, // Al Falah/Obhur north
  { name_en: 'Obhur Al Shamaliyah', name_ar: 'أبحر الشمالية', ...J(21.6800, 39.0900) },
  { name_en: 'Al Balad (Downtown)', name_ar: ' البلد', ...J(21.4860, 39.1800) },
  { name_en: 'Al Andalus', name_ar: 'الأندلس', ...J(21.6180, 39.2080) },
  { name_en: 'Al Marwah', name_ar: 'المروة', ...J(21.5290, 39.2450) },
  { name_en: 'King Abdulaziz Port', name_ar: 'ميناء الملك عبدالعزيز', ...J(21.4840, 39.1350) },
];

const CATEGORIES = [
  {
    slug: 'furniture', name_en: 'Furniture', name_ar: 'الأثاث', icon: 'sofa', state: 'active',
    desc_en: 'Sofas, beds, mattresses, wardrobes, flat-pack and used furniture, returns & exchanges.',
    desc_ar: 'كنب، أسرّة، مراتب، دواليب، أثاث تجميعي ومستعمل، الإرجاع والاستبدال.',
    items: [
      ['Sofa (3-seater)', 'كنب 3 مقاعد', 'bulky', 65, 2.2],
      ['Bed frame (king)', 'سرير مزدوج', 'bulky', 80, 2.8],
      ['Mattress', 'مرتبة', 'bulky', 35, 1.2],
      ['Dining table', 'طاولة طعام', 'bulky', 55, 1.8],
      ['Chair set (4)', 'طقم كراسي 4', 'bulky', 30, 1.0],
      ['Wardrobe', 'دولاب ملابس', 'extra_bulky', 120, 3.5],
      ['Flat-pack boxes', 'كراتين أثاث تجميعي', 'standard', 25, 0.6],
      ['Used furniture bundle', 'أثاث مستعمل', 'bulky', 90, 2.5],
    ],
  },
  {
    slug: 'appliances', name_en: 'Home Appliances', name_ar: 'الأجهزة المنزلية', icon: 'fridge', state: 'active',
    desc_en: 'Refrigerators, washers, dryers, ovens, dishwashers, TVs and AC units.',
    desc_ar: 'ثلاجات، غسالات، نشافات، أفران، غسالات صحون، شاشات ومكيفات.',
    items: [
      ['Refrigerator', 'ثلاجة', 'extra_bulky', 110, 2.2],
      ['Chest freezer', 'فريزر', 'extra_bulky', 90, 1.8],
      ['Washing machine', 'غسالة', 'bulky', 70, 1.0],
      ['Dryer', 'نشافة', 'bulky', 60, 1.0],
      ['Oven / cooker', 'فرن / طاولة طبخ', 'bulky', 65, 1.1],
      ['Dishwasher', 'غسالة صحون', 'bulky', 55, 0.9],
      ['TV 55"+', 'شاشة 55 بوصة+', 'standard', 20, 0.4],
      ['Split AC unit', 'مكيف سبليت', 'bulky', 45, 0.8],
    ],
  },
  {
    slug: 'retail', name_en: 'Retail & E-commerce', name_ar: 'التجزئة والتجارة الإلكترونية', icon: 'cart', state: 'active',
    desc_en: 'Clothing, shoes, cartons, online orders, Instagram & WhatsApp sellers, returns and multi-drop.',
    desc_ar: 'ملابس، أحذية، كراتين، طلبات المتاجر الإلكترونية وبائعات إنستقرام وواتساب، الإرجاع والتوصيلات المتعددة.',
    items: [
      ['Carton (standard)', 'كرتون قياسي', 'standard', 8, 0.08],
      ['Carton (large)', 'كرتون كبير', 'standard', 15, 0.2],
      ['Clothing bag', 'كيس ملابس', 'standard', 5, 0.05],
      ['Shoe boxes (set)', 'علب أحذية', 'standard', 6, 0.06],
      ['Return pickup', 'استلام مرتجع', 'standard', 5, 0.1],
    ],
  },
  {
    slug: 'business', name_en: 'Business & Commercial', name_ar: 'الأعمال والتجاري', icon: 'building', state: 'active',
    desc_en: 'Shop inventory, warehouse stock, office equipment, electrical & plumbing supplies, branch-to-branch.',
    desc_ar: 'بضائع المحلات، مخزون المستودعات، معدات المكاتب، مواد الكهرباء والصحي، التوصيل بين الفروع.',
    items: [
      ['Pallet (stacked)', 'منصة بضائع', 'bulky', 200, 1.5],
      ['Supply boxes (10)', 'صناديق تموين 10', 'standard', 60, 0.8],
      ['Office equipment', 'معدات مكتبية', 'standard', 25, 0.4],
      ['Electrical supplies', 'مواد كهربائية', 'standard', 40, 0.5],
      ['Plumbing supplies', 'مواد صحية', 'bulky', 80, 1.0],
    ],
  },
  {
    slug: 'events', name_en: 'Office & Events', name_ar: 'المكاتب والمناسبات', icon: 'event', state: 'active',
    desc_en: 'Tables, chairs, display stands and event equipment. Scheduled office and event deliveries.',
    desc_ar: 'طاولات، كراسي، ستاندات عرض ومعدات المناسبات. توصيل مجدول للمكاتب والفعاليات.',
    items: [
      ['Folding chairs (10)', 'كراسي قابلة للطي 10', 'bulky', 35, 1.2],
      ['Event tables (5)', 'طاولات مناسبات 5', 'bulky', 70, 2.0],
      ['Display stand', 'ستاند عرض', 'standard', 20, 0.5],
      ['Event equipment bundle', 'معدات مناسبات', 'bulky', 100, 2.5],
    ],
  },
  {
    slug: 'water', name_en: 'Water Delivery', name_ar: 'توصية المياه', icon: 'water', state: 'active',
    desc_en: 'Sealed drinking-water bottles, cartons and 5-gallon bottles. Multiple brands and pack sizes with repeat orders.',
    desc_ar: 'قنينات مياه شرب معتمدة، كراتين وغالونات 5 لتر. علامات متعددة وأحجام مختلفة مع الطلب المتكرر.',
    items: [],
  },
  {
    slug: 'lpg', name_en: 'LPG Gas Cylinders', name_ar: 'أسطوانات الغاز', icon: 'gas',
    // Compliance-gated: stays disabled until Admin verifies distributor licence,
    // vehicle approval and driver certificates. The API enforces this server-side.
    state: 'disabled',
    desc_en: 'Licensed gas distributor partners only. Enabled after compliance verification.',
    desc_ar: 'لموزعي الغاز المرخصين فقط. تُفعّل بعد التحقق من الاشتراطات.',
    items: [
      ['Cylinder 12 kg', 'أسطوانة 12 كجم', 'standard', 15, 0.06],
      ['Cylinder 25 kg', 'أسطوانة 25 كجم', 'bulky', 30, 0.12],
      ['Cylinder 50 kg', 'أسطوانة 50 كجم', 'bulky', 55, 0.25],
    ],
  },
];

export function seed() {
  if (get('SELECT id FROM categories LIMIT 1')) return false; // already seeded

  tx(() => {
    // ---- pricing config ----
    for (const [k, v] of Object.entries(PRICING_DEFAULTS)) {
      run('INSERT OR IGNORE INTO pricing_config (key, value, label) VALUES (?, ?, ?)',
        k, JSON.stringify(v.value), v.label);
    }

    // ---- zones (Jeddah districts) ----
    for (const d of DISTRICTS) {
      run('INSERT INTO zones (name_en, name_ar, lat, lng, radius_km, surcharge) VALUES (?, ?, ?, ?, ?, ?)',
        d.name_en.trim(), d.name_ar.trim(), d.lat, d.lng, 4, d.name_en.includes('Obhur') ? 25 : 0);
    }

    // ---- vehicles: 5 closed Toyota HiAce vans + 1 box truck ----
    const vans = [
      ['ج أ ب 4821', 'Toyota HiAce 2022 (closed)', 'hiace', 900, 7.8],
      ['ط ر س 1193', 'Toyota HiAce 2021 (closed)', 'hiace', 900, 7.8],
      ['ر ك ن 7304', 'Toyota HiAce High Roof 2023', 'hiace_high_roof', 1100, 10.5],
      ['ح م ي 5510', 'Toyota HiAce 2022 (closed)', 'hiace', 900, 7.8],
      ['س د ا 9042', 'Toyota HiAce 2020 (closed)', 'hiace', 900, 7.8],
      ['ب ن ق 2288', 'Box truck 3t 2019', 'box_truck', 2000, 16],
    ];
    for (const [plate, model, cls, kg, m3] of vans) {
      run('INSERT INTO vehicles (plate, model, class, payload_kg, volume_m3, lpg_approved) VALUES (?, ?, ?, ?, ?, 0)',
        plate, model, cls, kg, m3);
    }

    // ---- users ----
    const mkUser = (phone, name, role) => run(
      'INSERT INTO users (phone, name, role, lang) VALUES (?, ?, ?, ?)', phone, name, role, 'ar',
    ).lastInsertRowid;

    const adminId = mkUser('+966500000000', 'Operations Admin', 'super_admin');
    mkUser('+966555000111', 'Fahad Al-Qahtani', 'customer');
    mkUser('+966555000222', 'Nora Al-Sharif', 'customer');
    mkUser('+966555000333', 'Khalid Zain', 'customer');

    // Drivers — none LPG certified yet (compliance pending by design)
    const d1 = mkUser('+966555100001', 'Mohammed Yasin', 'driver');
    const d2 = mkUser('+966555100002', 'Abdul Rahman Haque', 'driver');
    const d3 = mkUser('+966555100003', 'Imran Sheikh', 'driver');
    const d4 = mkUser('+966555100004', 'Yusuf Abdalla', 'driver');
    const d5 = mkUser('+966555100005', 'Bilal Ahmed', 'driver');

    const vanIds = all('SELECT id FROM vehicles ORDER BY id').map((v) => v.id);
    const drivers = [d1, d2, d3, d4, d5];
    drivers.forEach((id, i) => {
      run(`INSERT INTO driver_profiles (user_id, vehicle_id, license_no, national_id, approved, availability, rating, total_jobs)
           VALUES (?, ?, ?, ?, 1, 'offline', ?, ?)`,
      id, vanIds[i], `DL-40${i}${i}98`, `10${i}34567${i}`, 4.6 + i * 0.08, 120 + i * 37);
    });
    // Two drivers online around Al Rawdah for the live demo
    run('UPDATE driver_profiles SET availability = ?, lat = 21.5620, lng = 39.1720 WHERE user_id = ?', 'online', d1);
    run('UPDATE driver_profiles SET availability = ?, lat = 21.5870, lng = 39.1480 WHERE user_id = ?', 'online', d2);

    // ---- categories + items ----
    let sort = 10;
    for (const c of CATEGORIES) {
      const cid = run(`INSERT INTO categories (slug, name_en, name_ar, desc_en, desc_ar, icon, state, sort_order, requires_helpers)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.slug, c.name_en, c.name_ar, c.desc_en, c.desc_ar, c.icon, c.state, sort, c.slug === 'furniture' || c.slug === 'appliances' ? 1 : 0).lastInsertRowid;
      sort += 10;
      for (const [en, ar, tier, kg, m3] of c.items) {
        run(`INSERT INTO category_items (category_id, name_en, name_ar, size_tier, est_weight_kg, est_volume_m3)
             VALUES (?, ?, ?, ?, ?, ?)`, cid, en, ar, tier, kg, m3);
      }
    }
    const waterCat = get("SELECT id FROM categories WHERE slug = 'water'").id;
    const lpgCat = get("SELECT id FROM categories WHERE slug = 'lpg'").id;

    // ---- merchants ----
    const mUser1 = mkUser('+966556200001', 'Rawand Furniture Gallery', 'merchant');
    const mUser2 = mkUser('+966556200002', 'Aqua Jeddah Water Supply', 'merchant');
    const mUser3 = mkUser('+966556200003', 'Jeddah Gas Distributors Co.', 'merchant');
    const merch1 = run(`INSERT INTO merchants (user_id, business_name, cr_number, vat_number, category_id, status, negotiated_discount_pct)
      VALUES (?, ?, ?, ?, ?, 'approved', 10)`,
    mUser1, 'Rawand Furniture Gallery', '4030123456', '300012345600003', get("SELECT id FROM categories WHERE slug='furniture'").id).lastInsertRowid;
    const merch2 = run(`INSERT INTO merchants (user_id, business_name, cr_number, vat_number, category_id, status, negotiated_discount_pct)
      VALUES (?, ?, ?, ?, ?, 'approved', 15)`,
    mUser2, 'Aqua Jeddah Water Supply', '4030765432', '300076543200003', waterCat).lastInsertRowid;
    const merch3 = run(`INSERT INTO merchants (user_id, business_name, cr_number, vat_number, category_id, status)
      VALUES (?, ?, ?, ?, ?, 'pending')`,
    mUser3, 'Jeddah Gas Distributors Co.', '4030998877', '300099887700003', lpgCat).lastInsertRowid;

    // ---- water products (supplier catalog + stock) ----
    const wp = [
      ['Nestlé Pure Life', 'نستله بور لايف', '330ml × 24 carton', 18, 240],
      ['Nestlé Pure Life', 'نستله بور لايف', '5 gallon bottle', 12, 180],
      ['Nova Water', 'نوفا', '330ml × 24 carton', 15, 300],
      ['Nova Water', 'نوفا', '5 gallon bottle', 10, 220],
      ['Berain', 'بيرين', '600ml × 12 carton', 14, 150],
      ['Aquafina', 'اكوافينا', '5 gallon bottle', 9, 90],
    ];
    for (const [en, ar, size, price, qty] of wp) {
      run('INSERT INTO water_products (merchant_id, brand_en, brand_ar, size_label, unit_price, stock_qty) VALUES (?, ?, ?, ?, ?, ?)',
        merch2, en, ar, size, price, qty);
    }

    // ---- LPG compliance: distributor is pending; NO verified rows → category stays locked ----
    run(`INSERT INTO lpg_compliance (driver_id, vehicle_id, doc_type, doc_ref, verified)
         VALUES (?, ?, 'distributor_licence', 'LIC-GAS-2024-1187', 0)`, d5, vanIds[4]);
    run(`INSERT INTO lpg_compliance (driver_id, vehicle_id, doc_type, doc_ref, verified)
         VALUES (?, ?, 'vehicle_approval', 'CIV-GAS-2024-0442', 0)`, d5, vanIds[4]);

    // ---- addresses ----
    const addr = (userId, label, contact, phone, district, address, lat, lng) =>
      run(`INSERT INTO addresses (user_id, owner_type, label, contact_name, contact_phone, district, address, lat, lng)
           VALUES (?, 'customer', ?, ?, ?, ?, ?, ?, ?)`,
      userId, label, contact, phone, district, address, lat, lng);
    addr(2, 'Home', 'Fahad Al-Qahtani', '+966555000111', 'Al Rawdah', 'Prince Sultan Rd, Al Rawdah, villa 24', 21.5620, 39.1720);
    addr(2, 'Office', 'Fahad Al-Qahtani', '+966555000111', 'Al Zahra', 'Madinah Rd, Al Zahra, office tower 3', 21.6060, 39.1810);
    addr(3, 'Apartment', 'Nora Al-Sharif', '+966555000222', 'Al Salamah', 'Al Andalus St, Al Salamah, apt 12', 21.5870, 39.1480);
    addr(4, 'Shop', 'Khalid Zain', '+966555000333', 'Al Balad (Downtown)', 'Souq Al Jadid, Al Balad, shop 8', 21.4860, 39.1800);

    // merchant pickup addresses
    run(`INSERT INTO addresses (user_id, owner_type, label, contact_name, contact_phone, district, address, lat, lng)
         VALUES (?, 'merchant', ?, ?, ?, ?, ?, ?, ?)`,
    mUser1, 'Showroom', 'Rawand Furniture', '+966556200001', 'Al Andalus', 'Tahlia St, Rawand Gallery warehouse', 21.6180, 39.2080);
    run(`INSERT INTO addresses (user_id, owner_type, label, contact_name, contact_phone, district, address, lat, lng)
         VALUES (?, 'merchant', ?, ?, ?, ?, ?, ?, ?)`,
    mUser2, 'Depot', 'Aqua Jeddah', '+966556200002', 'King Abdulaziz Port', 'Industrial zone 1, water depot', 21.4840, 39.1350);

    // ---- promos ----
    run("INSERT INTO promos (code, kind, value, min_order, max_uses, active) VALUES ('JEDDAH10', 'percent', 10, 60, 500, 1)");
    run("INSERT INTO promos (code, kind, value, min_order, active) VALUES ('WELCOME25', 'fixed', 25, 80, 1)");

    // ---- demo orders (historic, delivered + one live pending) ----
    const furnitureCat = get("SELECT id FROM categories WHERE slug='furniture'").id;
    const retailCat = get("SELECT id FROM categories WHERE slug='retail'").id;
    const mkOrder = (waybill, cust, drv, cat, status, fee, dist, pm, ps, day) => {
      const vat = Math.round(fee * 0.15 * 100) / 100;
      const oid = run(`INSERT INTO orders (waybill, customer_id, driver_id, category_id, status, distance_km,
        delivery_fee, vat, total, payment_method, payment_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(?,'-3 hours'), datetime(?,'-3 hours'))`,
      waybill, cust, drv, cat, status, dist, fee, vat, Math.round((fee + vat) * 100) / 100, pm, ps, day, day).lastInsertRowid;
      run(`INSERT INTO order_stops (order_id, kind, seq, address, district, lat, lng, contact_name, contact_phone, done)
           VALUES (?, 'pickup', 1, 'Tahlia St, Rawand Gallery warehouse', 'Al Andalus', 21.6180, 39.2080, 'Rawand Furniture', '+966556200001', ?)`,
      oid, status === 'delivered' ? 1 : 0);
      run(`INSERT INTO order_stops (order_id, kind, seq, address, district, lat, lng, contact_name, contact_phone, done)
           VALUES (?, 'dropoff', 1, 'Prince Sultan Rd, Al Rawdah, villa 24', 'Al Rawdah', 21.5620, 39.1720, 'Fahad Al-Qahtani', '+966555000111', ?)`,
      oid, status === 'delivered' ? 1 : 0);
      run(`INSERT INTO order_events (order_id, status, actor_id, note, at)
           VALUES (?, 'pending', ?, 'Order created', datetime(?,'-3 hours'))`, oid, cust, day);
      if (drv) run(`INSERT INTO order_events (order_id, status, actor_id, note, at)
           VALUES (?, 'assigned', ?, 'Dispatched to driver', datetime(?,'-2 hours'))`, oid, drv, day);
      if (status === 'delivered') {
        run(`INSERT INTO order_events (order_id, status, actor_id, note, at)
             VALUES (?, 'delivered', ?, 'Delivered — OTP verified', datetime(?,'-1 hours'))`, oid, drv, day);
        run('INSERT INTO pod_records (order_id, method, otp_verified, receiver_name, gps_lat, gps_lng) VALUES (?, ?, 1, ?, 21.5620, 39.1720)',
          oid, 'otp', 'Fahad Al-Qahtani');
        run('UPDATE orders SET rating = 5, rating_comment = ? WHERE id = ?', 'Great service, on time.', oid);
      }
      return oid;
    };
    mkOrder('FIA-251101-0001', 2, d1, furnitureCat, 'delivered', 95, 8.4, 'card', 'paid', '2025-11-01');
    mkOrder('FIA-251102-0002', 3, d2, retailCat, 'delivered', 55, 4.1, 'cash', 'paid', '2025-11-02');
    mkOrder('FIA-251103-0003', 4, d3, furnitureCat, 'delivered', 130, 14.6, 'cash', 'paid', '2025-11-03');
    mkOrder('FIA-251104-0004', 2, null, retailCat, 'pending', 60, 5.2, 'cash', 'unpaid', '2025-11-04');

    // merchant invoice (previous month)
    const inv = run(`INSERT INTO invoices (number, merchant_id, period, subtotal, vat, total, status)
      VALUES ('INV-2510-0001', ?, '2025-10', 1450, 217.5, 1667.5, 'issued')`, merch1).lastInsertRowid;
    run('INSERT INTO invoice_lines (invoice_id, description, amount) VALUES (?, ?, ?)', inv, '18 furniture deliveries — October 2025', 1450);

    // settlement
    run(`INSERT INTO driver_settlements (driver_id, period, jobs, gross, commission_pct, payout, status)
         VALUES (?, '2025-10', 22, 3100, 30, 2170, 'paid')`, d1);

    audit(adminId, 'seed', 'system', null, 'Demo data seeded (Jeddah)');
  });

  return true;
}
