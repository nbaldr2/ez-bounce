import { z } from 'zod';
import { config } from './config.js';
import { keys, redis } from './redis.js';
import type { Settings } from './types.js';
import { PROVIDER_GROUPS } from './types.js';

const perGroupSchema = z.object({
  // Hard ceiling of 50: this tool's whole purpose is to not hammer MX servers.
  concurrency: z.number().int().min(1).max(50),
  delayMs: z.number().int().min(0).max(600_000),
});

export const settingsSchema = z.object({
  groups: z.object({
    gmail: perGroupSchema,
    microsoft: perGroupSchema,
    yahoo: perGroupSchema,
    apple: perGroupSchema,
    proton: perGroupSchema,
    other: perGroupSchema,
  }),
  retryBackoffMs: z.array(z.number().int().min(1_000).max(24 * 60 * 60_000)).min(0).max(10),
  reacherTimeoutMs: z.number().int().min(1_000).max(300_000),
  fullInboxAsCatchAll: z.boolean(),
});

export const settingsPatchSchema = settingsSchema.deepPartial();

let cache: { value: Settings; at: number } | null = null;
/**
 * Workers ask for settings on every address, so we cache — but only for a
 * second. Tuning concurrency/delay from the UI has to take effect on a live run
 * without a restart, which is the whole point of the settings panel.
 */
const CACHE_MS = 1_000;

function clone(s: Settings): Settings {
  return {
    groups: Object.fromEntries(
      PROVIDER_GROUPS.map((g) => [g, { ...s.groups[g] }]),
    ) as Settings['groups'],
    retryBackoffMs: [...s.retryBackoffMs],
    reacherTimeoutMs: s.reacherTimeoutMs,
    fullInboxAsCatchAll: s.fullInboxAsCatchAll,
  };
}

export async function getSettings(force = false): Promise<Settings> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  let value = clone(config.defaults);
  try {
    const raw = await redis.get(keys.settings);
    if (raw) {
      const parsed = settingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        value = parsed.data;
      } else {
        console.warn('[settings] stored settings failed validation, using env defaults');
      }
    }
  } catch (err) {
    console.warn('[settings] could not read from redis, using env defaults:', (err as Error).message);
  }

  cache = { value, at: Date.now() };
  return value;
}

/** Deep-merges a patch over current settings, validates, and persists. */
export async function updateSettings(patch: unknown): Promise<Settings> {
  const parsedPatch = settingsPatchSchema.parse(patch);
  const current = await getSettings(true);

  const next: Settings = clone(current);
  if (parsedPatch.groups) {
    for (const g of PROVIDER_GROUPS) {
      const p = parsedPatch.groups[g];
      if (p) next.groups[g] = { ...next.groups[g], ...p };
    }
  }
  if (parsedPatch.retryBackoffMs) {
    next.retryBackoffMs = parsedPatch.retryBackoffMs.filter((n): n is number => typeof n === 'number');
  }
  if (parsedPatch.reacherTimeoutMs !== undefined) next.reacherTimeoutMs = parsedPatch.reacherTimeoutMs;
  if (parsedPatch.fullInboxAsCatchAll !== undefined) {
    next.fullInboxAsCatchAll = parsedPatch.fullInboxAsCatchAll;
  }

  const validated = settingsSchema.parse(next);
  await redis.set(keys.settings, JSON.stringify(validated));
  cache = { value: validated, at: Date.now() };
  return validated;
}

/** Drops persisted overrides so the env-var defaults apply again. */
export async function resetSettings(): Promise<Settings> {
  await redis.del(keys.settings);
  cache = null;
  return getSettings(true);
}

export function envDefaults(): Settings {
  return clone(config.defaults);
}
