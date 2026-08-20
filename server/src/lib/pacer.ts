import { keys, redis } from '../redis.js';

/**
 * Distributed request pacer.
 *
 * BullMQ's built-in `limiter` is fixed at Worker construction time, which makes
 * it useless for the "tune it live while a 100k job is running" requirement. So
 * instead each worker reserves its own slot on a shared timeline held in Redis.
 *
 * The Lua script is the important part: read-max-write is atomic, so N workers
 * across any number of processes can never hand themselves the same slot. Each
 * caller learns how long to sleep before it is allowed to talk to the MX.
 *
 * Effective throughput per pool is therefore
 *   min(concurrency / avg_latency, 1000 / delayMs)  requests/sec
 * which lets you cap Gmail at a genuinely safe rate regardless of how fast
 * Reacher happens to be answering.
 */
const RESERVE_SCRIPT = `
local key   = KEYS[1]
local now   = tonumber(ARGV[1])
local delay = tonumber(ARGV[2])
local ttl   = tonumber(ARGV[3])

if delay <= 0 then
  return 0
end

local nextAt = tonumber(redis.call('GET', key) or '0')
local slot = now
if nextAt > now then
  slot = nextAt
end

redis.call('SET', key, slot + delay, 'PX', ttl)
return slot - now
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    ezdReserveSlot(key: string, now: string, delay: string, ttl: string): Promise<number>;
  }
}

redis.defineCommand('ezdReserveSlot', { numberOfKeys: 1, lua: RESERVE_SCRIPT });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Blocks until this caller is allowed to issue its request.
 *
 * If Redis is unreachable we fall back to sleeping the full delay locally:
 * over-throttling is always the safe failure mode here.
 */
export async function acquireSlot(group: string, delayMs: number): Promise<number> {
  if (delayMs <= 0) return 0;

  // Keep the key alive comfortably longer than the queue of reservations.
  const ttl = Math.max(60_000, delayMs * 10);

  let waitMs: number;
  try {
    waitMs = await redis.ezdReserveSlot(
      keys.pace(group),
      String(Date.now()),
      String(delayMs),
      String(ttl),
    );
  } catch (err) {
    console.warn(`[pacer] redis reservation failed for ${group}, pacing locally:`, (err as Error).message);
    waitMs = delayMs;
  }

  if (waitMs > 0) await sleep(waitMs);
  return waitMs;
}

/** Clears a pool's timeline, e.g. after lowering the delay mid-run. */
export async function resetPacer(group: string): Promise<void> {
  await redis.del(keys.pace(group));
}
