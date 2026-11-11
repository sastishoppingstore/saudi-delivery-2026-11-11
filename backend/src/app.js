import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { orderRoutes } from './routes/orders.js';
import { driverRoutes } from './routes/driver.js';
import { merchantRoutes } from './routes/merchant.js';
import { adminRoutes } from './routes/admin.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Security headers (lesson from the RE reports: no cleartext, no sniffing, no framing)
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    });
    next();
  });

  app.get('/health', (req, res) => res.json({ ok: true, app: 'fiasta', city: 'jeddah' }));
  app.use('/api', authRoutes);
  app.use('/api', catalogRoutes);
  app.use('/api', orderRoutes);
  app.use('/api', driverRoutes);
  app.use('/api', merchantRoutes);
  app.use('/api', adminRoutes);

  // Item/driver photos
  app.use('/uploads', express.static(join(here, '..', 'data', 'uploads'), { maxAge: '1d' }));

  // Web apps (all four frontends)
  const pub = join(here, '..', 'public');
  app.use('/shared', express.static(join(pub, 'shared')));
  app.use('/admin', express.static(join(pub, 'admin')));
  app.use('/driver', express.static(join(pub, 'driver')));
  app.use('/merchant', express.static(join(pub, 'merchant')));
  app.use('/app', express.static(join(pub, 'customer')));
  app.use('/docs', express.static(join(here, '..', '..', 'docs')));
  app.use('/i18n', express.static(join(here, '..', '..', 'i18n'), { maxAge: '1h' }));
  app.use('/track', express.static(join(pub, 'track')));

  // Root → landing page linking all four apps
  app.get('/', (req, res) => res.sendFile(join(pub, 'index.html')));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
    console.error(err);
    res.status(500).json({ error: 'server error' });
  });

  return app;
}
