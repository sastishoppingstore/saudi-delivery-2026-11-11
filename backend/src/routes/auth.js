import { Router } from 'express';
import { config } from '../config.js';
import { all, get, run } from '../db.js';
import { normalizePhone, requestOtp, verifyOtp, signToken, requireAuth } from '../auth.js';
import { emitToAdmins } from '../realtime.js';

export const authRoutes = Router();

export function publicUser(u) {
  return { id: u.id, phone: u.phone, name: u.name, role: u.role, lang: u.lang };
}

// ---------- Auth (Mrsool-style phone → OTP → token) ----------
authRoutes.post('/auth/otp/request', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid Saudi mobile number' });
  res.json(requestOtp(phone));
});

authRoutes.post('/auth/otp/verify', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone || !req.body?.code) return res.status(400).json({ error: 'phone and code required' });
  if (!verifyOtp(phone, req.body.code)) return res.status(401).json({ error: 'invalid or expired code' });

  let user = get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) {
    const role = config.adminPhones.includes(phone) ? 'super_admin' : 'customer';
    const name = typeof req.body.name === 'string' ? req.body.name.slice(0, 80) : '';
    const lang = req.body.lang === 'en' ? 'en' : 'ar';
    const r = run('INSERT INTO users (phone, name, role, lang) VALUES (?, ?, ?, ?)', phone, name, role, lang);
    user = get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid);
  }
  if (!user.active) return res.status(403).json({ error: 'account disabled' });
  res.json({ token: signToken(user.id, user.role), user: publicUser(user) });
});

authRoutes.post('/auth/driver/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid Saudi mobile number' });
  if (!verifyOtp(phone, req.body?.code)) return res.status(401).json({ error: 'invalid or expired code' });
  const existing = get('SELECT id, role FROM users WHERE phone = ?', phone);
  if (existing && existing.role !== 'driver') return res.status(409).json({ error: 'phone already used' });
  const name = String(req.body.name || '').slice(0, 80);
  let id = existing?.id;
  if (!id) id = run("INSERT INTO users (phone, name, role) VALUES (?, ?, 'driver')", phone, name).lastInsertRowid;
  run(`INSERT INTO driver_profiles (user_id, license_no, national_id) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET license_no = excluded.license_no, national_id = excluded.national_id`,
  id, String(req.body.licenseNo || '').slice(0, 40), String(req.body.nationalId || '').slice(0, 20));
  emitToAdmins('driver:pending', { id, name });
  res.status(201).json({ message: 'registered — waiting for admin approval' });
});

authRoutes.post('/auth/merchant/register', (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'invalid Saudi mobile number' });
  if (!verifyOtp(phone, req.body?.code)) return res.status(401).json({ error: 'invalid or expired code' });
  const existing = get('SELECT id, role FROM users WHERE phone = ?', phone);
  if (existing && existing.role !== 'merchant') return res.status(409).json({ error: 'phone already used' });
  const name = String(req.body.name || '').slice(0, 80);
  let uid = existing?.id;
  if (!uid) uid = run("INSERT INTO users (phone, name, role) VALUES (?, ?, 'merchant')", phone, name).lastInsertRowid;
  const businessName = String(req.body.businessName || name).slice(0, 120);
  const cat = get('SELECT id FROM categories WHERE id = ? OR slug = ?', req.body.categoryId, req.body.categorySlug || req.body.categoryId);
  const mid = run(`INSERT INTO merchants (user_id, business_name, cr_number, vat_number, category_id, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
    ON CONFLICT(user_id) DO UPDATE SET business_name = excluded.business_name,
      cr_number = excluded.cr_number, vat_number = excluded.vat_number, category_id = excluded.category_id`,
  uid, businessName, String(req.body.crNumber || '').slice(0, 30), String(req.body.vatNumber || '').slice(0, 30), cat?.id || null).lastInsertRowid;
  emitToAdmins('merchant:pending', { id: mid, businessName });
  res.status(201).json({ merchantId: mid, message: 'registered — waiting for admin approval' });
});

// ---------- Me ----------
authRoutes.get('/me', requireAuth(), (req, res) => {
  const user = get('SELECT * FROM users WHERE id = ?', req.user.id);
  let extra = null;
  if (req.user.role === 'driver') {
    extra = get(`SELECT dp.*, v.plate, v.model, v.class, v.payload_kg, v.volume_m3, v.lpg_approved
      FROM driver_profiles dp LEFT JOIN vehicles v ON v.id = dp.vehicle_id WHERE dp.user_id = ?`, req.user.id);
  }
  if (req.user.role === 'merchant') extra = get('SELECT * FROM merchants WHERE user_id = ?', req.user.id);
  res.json({ user: publicUser(user), profile: extra });
});

authRoutes.patch('/me', requireAuth(), (req, res) => {
  const name = String(req.body?.name || '').slice(0, 80);
  const lang = ['ar', 'en'].includes(req.body?.lang) ? req.body.lang : null;
  if (name) run('UPDATE users SET name = ? WHERE id = ?', name, req.user.id);
  if (lang) run('UPDATE users SET lang = ? WHERE id = ?', lang, req.user.id);
  res.json({ user: publicUser(get('SELECT * FROM users WHERE id = ?', req.user.id)) });
});

authRoutes.get('/notifications', requireAuth(), (req, res) => {
  res.json(all('SELECT id, title, body, read, created_at FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', req.user.id));
});

authRoutes.post('/notifications/read', requireAuth(), (req, res) => {
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', req.user.id);
  res.json({ ok: true });
});

// Device push token (FCM integration stub)
authRoutes.post('/device-token', requireAuth(), (req, res) => {
  const token = String(req.body?.token || '').slice(0, 200);
  if (!token) return res.status(400).json({ error: 'token required' });
  run('INSERT OR IGNORE INTO device_tokens (user_id, token, platform) VALUES (?, ?, ?)',
    req.user.id, token, ['android', 'ios', 'web'].includes(req.body?.platform) ? req.body.platform : 'web');
  res.status(201).json({ ok: true, note: 'push provider integration stub — token stored, no push sent' });
});
