import { randomBytes } from 'node:crypto';

// All tunables live here. Override with environment variables in production.
export const config = {
  port: Number(process.env.PORT || 3000),
  dbPath: process.env.DB_PATH || 'data/delivery.db',
  // Secret used to sign JWTs. MUST be set in production.
  jwtSecret: process.env.JWT_SECRET || randomBytes(32).toString('hex'),
  jwtTtlSeconds: 60 * 60 * 24 * 30,
  // In development the OTP is returned in the API response so the apps can be tested
  // without an SMS gateway. Set OTP_DEBUG=false in production.
  otpDebug: process.env.OTP_DEBUG !== 'false',
  otpTtlSeconds: 5 * 60,
  // Phone numbers that get the admin role when they first log in.
  adminPhones: (process.env.ADMIN_PHONES || '+966500000000').split(',').map((s) => s.trim()),
  currency: 'SAR',
  pricing: {
    baseFee: 50,       // SAR minimum delivery fee (see pricing_config for the full engine)
    perKm: 0,
    minFee: 50,        // SAR minimum — business rule
    vatRate: 0.15,     // Saudi VAT 15%
    roadFactor: 1.3,
  },
  dispatchRadiusKm: 10, // drivers farther than this do not see a new order
};
