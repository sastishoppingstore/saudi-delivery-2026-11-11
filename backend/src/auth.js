import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { get, run } from './db.js';

const SAUDI_MOBILE = /^\+9665\d{8}$/;

/** Normalize 05XXXXXXXX / 9665XXXXXXXX / +9665XXXXXXXX to +9665XXXXXXXX. */
export function normalizePhone(input = '') {
  let p = String(input).replace(/[\s-]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (/^05\d{8}$/.test(p)) p = '+966' + p.slice(1);
  if (/^9665\d{8}$/.test(p)) p = '+' + p;
  return SAUDI_MOBILE.test(p) ? p : null;
}

export function requestOtp(phone) {
  const code = String(randomInt(100000, 1000000));
  const expires = Math.floor(Date.now() / 1000) + config.otpTtlSeconds;
  run(
    `INSERT INTO otp_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)
     ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0`,
    phone, code, expires,
  );
  // TODO(production): send `code` by SMS through a Saudi SMS gateway (e.g. Unifonic, Taqnyat).
  console.log(`[otp] ${phone} -> ${code}`);
  return config.otpDebug ? { debugCode: code } : {};
}

/** Returns true when the code is valid. Each wrong try counts; 5 tries burns the code. */
export function verifyOtp(phone, code) {
  const row = get('SELECT code, expires_at, attempts FROM otp_codes WHERE phone = ?', phone);
  if (!row || row.expires_at < Math.floor(Date.now() / 1000) || row.attempts >= 5) return false;
  const a = Buffer.from(String(code));
  const b = Buffer.from(row.code);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (ok) {
    run('DELETE FROM otp_codes WHERE phone = ?', phone);
  } else {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
  }
  return ok;
}

// ---- Minimal HS256 JWT (no external dependency) ----
const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function signToken(userId, role) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: userId, role, iat: now, exp: now + config.jwtTtlSeconds }));
  const sig = createHmac('sha256', config.jwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', config.jwtSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/** Express middleware: requires a valid Bearer token and loads the user. */
export function requireAuth(...roles) {
  return (req, res, next) => {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'unauthorized' });
    const user = get('SELECT id, phone, name, role, active FROM users WHERE id = ?', payload.sub);
    if (!user || !user.active) return res.status(401).json({ error: 'unauthorized' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error: 'forbidden' });
    req.user = user;
    next();
  };
}
