import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { config } from './config.js';
import { closeDb, databaseHealthy, initDb } from './db.js';
import { redis } from './redis.js';
import { reacherHealthy } from './lib/reacher.js';
import { uploadsRouter } from './routes/uploads.js';
import { jobsRouter } from './routes/jobs.js';
import { settingsRouter } from './routes/settings.js';
import { allGroupCounts, closeQueues, startQueueEvents } from './queue/queues.js';
import { startWorkers, stopWorkers } from './queue/worker.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  const [reacher, queues, database] = await Promise.all([
    reacherHealthy(),
    allGroupCounts().catch(() => null),
    databaseHealthy(),
  ]);
  let redisOk = false;
  try {
    redisOk = (await redis.ping()) === 'PONG';
  } catch {
    redisOk = false;
  }

  const ok = reacher.ok && redisOk && database;
  res.status(ok ? 200 : 503).json({
    ok,
    redis: redisOk,
    database,
    reacher,
    reacherUrl: config.reacherUrl,
    queues,
    workers: config.runWorkers,
  });
});

app.use('/api/uploads', uploadsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/settings', settingsRouter);

// Serve the built SPA when present (single-container deployment).
if (fs.existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(config.webDist, 'index.html'));
  });
  console.log(`[web] serving SPA from ${config.webDist}`);
} else {
  console.log(`[web] no build at ${config.webDist} (run the Vite dev server separately)`);
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', details: err.flatten() });
    return;
  }
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: message });
});

async function main(): Promise<void> {
  await initDb();
  startQueueEvents();

  if (config.runWorkers) {
    await startWorkers();
  } else {
    console.log('[worker] RUN_WORKERS=false, this process serves the API only');
  }

  const server = app.listen(config.port, () => {
    console.log(`[api] listening on :${config.port}`);
    console.log(`[api] reacher at ${config.reacherUrl}`);
    console.log('[api] PostgreSQL connected');
  });

  // Warn early rather than letting every address fail with a connection error.
  void reacherHealthy().then((h) => {
    if (!h.ok) {
      console.warn(
        `[api] WARNING: cannot reach the Reacher sidecar at ${config.reacherUrl} (${h.detail}). ` +
          'Verification will fail until it is up.',
      );
    }
  });

  const shutdown = async (signal: string) => {
    console.log(`[api] ${signal} received, shutting down`);
    server.close();
    await stopWorkers();
    await closeQueues();
    await closeDb().catch(() => undefined);
    await redis.quit().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
