import express from 'express';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook.js';
import { query } from './config/database.js';
import { log } from './utils/logger.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use((req, _res, next) => {
  if (req.path === '/health') return next();
  log.info(`→ ${req.method} ${req.originalUrl} from ${req.ip}`);
  log.debug('Request body:', JSON.stringify(req.body));
  next();
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'webhook-autofill', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(Number(PORT), HOST, () => {
  log.info(`Webhook autofill listening on http://${HOST}:${PORT}`);
  log.info(`LOG_LEVEL=${process.env.LOG_LEVEL || 'info'}`);
  (async () => {
    try {
      await query('SELECT 1');
      log.info('Database: connected');
    } catch (e) {
      log.error('Database: connection failed', (e as Error).message);
    }
  })();
});
