import { Router } from 'express';
import { envDefaults, getSettings, resetSettings, updateSettings } from '../settings.js';
import { resetPacer } from '../lib/pacer.js';
import { PROVIDER_GROUPS } from '../types.js';

export const settingsRouter = Router();

settingsRouter.get('/', async (_req, res, next) => {
  try {
    res.json({
      settings: await getSettings(true),
      envDefaults: envDefaults(),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/settings
 * Accepts a partial settings object. Changes are picked up by running workers
 * within ~2s (concurrency) or on the next address (delay/backoff/timeout), so
 * a 100k job can be retuned without restarting anything.
 */
settingsRouter.patch('/', async (req, res, next) => {
  try {
    const settings = await updateSettings(req.body ?? {});
    // Lowering a delay leaves a stale future reservation on the timeline; clear
    // it so the new rate takes effect immediately instead of after the old
    // backlog of slots drains.
    await Promise.all(PROVIDER_GROUPS.map((g) => resetPacer(g)));
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});

settingsRouter.post('/reset', async (_req, res, next) => {
  try {
    const settings = await resetSettings();
    await Promise.all(PROVIDER_GROUPS.map((g) => resetPacer(g)));
    res.json({ settings });
  } catch (err) {
    next(err);
  }
});
