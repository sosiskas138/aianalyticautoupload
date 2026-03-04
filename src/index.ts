import express from 'express';
import dotenv from 'dotenv';
import webhookRoutes from './routes/webhook.js';
import { query } from './config/database.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3002;
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'webhook-autofill', timestamp: new Date().toISOString() });
});

app.use('/webhook', webhookRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(Number(PORT), HOST, () => {
  console.log(`Webhook autofill listening on http://${HOST}:${PORT}`);
  (async () => {
    try {
      await query('SELECT 1');
      console.log('Database: connected');
    } catch (e) {
      console.error('Database: connection failed', (e as Error).message);
    }
  })();
});
