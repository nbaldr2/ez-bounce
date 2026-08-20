import { Queue, QueueEvents } from 'bullmq';
import { createQueueConnection } from '../redis.js';
import type { ProviderGroup } from '../types.js';
import { PROVIDER_GROUPS } from '../types.js';

export interface VerifyJobData {
  jobId: string;
  email: string;
  domain: string;
  group: ProviderGroup;
  /**
   * 1-based attempt counter, carried in the payload rather than relying on
   * BullMQ's own `attemptsMade`.
   *
   * Retries are re-enqueued explicitly as fresh delayed jobs instead of using
   * BullMQ's `backoff` option, for two reasons: the backoff schedule is read
   * from live settings at the moment of requeue (so retuning it mid-run
   * actually takes effect), and a temp-fail never marks a BullMQ job as
   * "failed", keeping the failed set meaningful for real bugs.
   */
  attempt: number;
}

/**
 * One queue per provider pool.
 *
 * This is what "batch all @gmail.com addresses together and process them
 * through a single concurrency-limited worker pool" means in practice: Gmail
 * traffic is physically confined to the `verify:gmail` queue, which has exactly
 * one Worker with concurrency 2-3 attached to it. A 100k list that is 90% Gmail
 * cannot spike Google's MX no matter how idle the other pools are, and the fast
 * `other` pool keeps draining at full speed in parallel.
 */
export function queueName(group: ProviderGroup): string {
  // BullMQ rejects ':' in queue names (it is its own Redis key separator).
  return `verify-${group}`;
}

const connection = createQueueConnection();

export const queues: Record<ProviderGroup, Queue<VerifyJobData>> = Object.fromEntries(
  PROVIDER_GROUPS.map((g) => [
    g,
    new Queue<VerifyJobData>(queueName(g), {
      connection,
      defaultJobOptions: {
        // Keep the tail of finished jobs only; results live in SQLite.
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    }),
  ]),
) as Record<ProviderGroup, Queue<VerifyJobData>>;

export function getQueue(group: ProviderGroup): Queue<VerifyJobData> {
  return queues[group];
}

let events: QueueEvents[] = [];

export function startQueueEvents(): void {
  if (events.length > 0) return;
  events = PROVIDER_GROUPS.map(
    (g) => new QueueEvents(queueName(g), { connection: createQueueConnection() }),
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all(events.map((e) => e.close()));
  await Promise.all(PROVIDER_GROUPS.map((g) => queues[g].close()));
  events = [];
}

export interface GroupQueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  paused: boolean;
}

export async function groupCounts(group: ProviderGroup): Promise<GroupQueueCounts> {
  const q = queues[group];
  const [counts, paused] = await Promise.all([
    q.getJobCounts('waiting', 'active', 'delayed', 'prioritized'),
    q.isPaused(),
  ]);
  return {
    waiting: (counts.waiting ?? 0) + (counts.prioritized ?? 0),
    active: counts.active ?? 0,
    delayed: counts.delayed ?? 0,
    paused,
  };
}

export async function allGroupCounts(): Promise<Record<ProviderGroup, GroupQueueCounts>> {
  const entries = await Promise.all(
    PROVIDER_GROUPS.map(async (g) => [g, await groupCounts(g)] as const),
  );
  return Object.fromEntries(entries) as Record<ProviderGroup, GroupQueueCounts>;
}

export async function pauseAll(): Promise<void> {
  await Promise.all(PROVIDER_GROUPS.map((g) => queues[g].pause()));
}

export async function resumeAll(): Promise<void> {
  await Promise.all(PROVIDER_GROUPS.map((g) => queues[g].resume()));
}
