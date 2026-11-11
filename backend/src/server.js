import { createServer } from 'node:http';
import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { initRealtime } from './realtime.js';
import { seed } from './seed.js';

openDb();
if (seed()) console.log('Seeded Jeddah demo data (categories, fleet, drivers, merchants, orders).');
const app = createApp();
const server = createServer(app);

await initRealtime(server);

server.listen(config.port, () => {
  console.log(`Fiasta API listening on http://localhost:${config.port}`);
  console.log('  Customer app : /app');
  console.log('  Driver app   : /driver');
  console.log('  Merchant     : /merchant');
  console.log('  Admin panel  : /admin');
  if (config.otpDebug) console.log('  OTP_DEBUG is on: OTP codes are returned in API responses (dev only).');
});
