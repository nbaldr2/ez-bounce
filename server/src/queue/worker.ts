import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from '../redis.js';
import { getSettings } from '../settings.js';
import { acquireSlot } from '../lib/pacer.js';
import { verifyEmail } from '../lib/smtp-verify.js';
import {
  getJob,
  incrTempFailEvents,
  isCancelled,
  maybeComplete,
  recordResult,
  requeueWithBackoff,
} from '../lib/jobstore.js';
import { queueName, type VerifyJobData } from './queues.js';
import type { ProviderGroup, Reason } from '../types.js';
import { PROVIDER_GROUPS } from '../types.js';

const workers = new Map<ProviderGroup, Worker<VerifyJobData>>();
let concurrencyTimer: NodeJS.Timeout | null = null;

/**
 * Processes one address.
 *
 * The ordering here is deliberate: cancellation check, then pacing slot, then
 * the SMTP call. Acquiring the slot *before* the network call is what enforces
 * the delay between request starts; doing it after would let a burst of workers
 * all hit the MX simultaneously and only then queue up politely.
 */
async function process(job: Job<VerifyJobData>): Promise<void> {
  const { jobId, email, domain, group, attempt } = job.data;

  const parent = getJob(jobId);
  if (!parent) return; // Job record deleted; drop silently.

  if (parent.status === 'cancelled' || (await isCancelled(jobId))) {
    return;
  }

  const settings = await getSettings();
  const maxAttempts = settings.retryBackoffMs.length + 1;

  await acquireSlot(group, settings.groups[group].delayMs);

  // Re-check cancellation: with a 10-minute backoff and a slow pool, a job can
  // sit in the pacer long after the operator hit stop.
  if (await isCancelled(jobId)) return;

  // ---- direct SMTP verification ------------------------------------------
  //
  // Opens EHLO → MAIL FROM → RCPT TO on the target MX. No sidecar, no
  // headless Chrome: just the SMTP conversation that every verifier ultimately
  // performs. This replaces the Reacher HTTP call because the reacherhq/backend
  // image routes Microsoft/Yahoo through a headless Chrome instance that
  // reliably crashes in Docker, returning `unknown` for every address.
  const result = await verifyEmail(email);

  // ---- temp-fail (4xx) — retry with backoff --------------------------------
  if (result.reason === 'greylisted' || result.reason === 'connection_error') {
    await incrTempFailEvents(jobId);

    if (attempt < maxAttempts) {
      const delayMs = settings.retryBackoffMs[attempt - 1] ?? settings.retryBackoffMs.at(-1) ?? 30_000;
      await requeueWithBackoff(job.data, attempt + 1, delayMs);
      return;
    }

    // Backoff exhausted: record as unknown, never invalid.
    await recordResult({
      jobId, email, domain, group,
      category: 'unknown',
      reason: 'temp_fail_exhausted',
      reacherStatus: null,
      attempts: attempt,
      smtpCode: result.smtpCode,
      message: result.message,
      raw: null,
    });
    await maybeComplete(jobId);
    return;
  }

  // ---- terminal verdict ----------------------------------------------------
  await recordResult({
    jobId, email, domain, group,
    category: result.category === 'valid' ? 'valid' :
              result.category === 'invalid' ? 'invalid' :
              result.category === 'catch_all' ? 'catch_all' : 'unknown',
    reason: result.reason as Reason,
    reacherStatus: null,
    attempts: attempt,
    smtpCode: result.smtpCode,
    message: result.message,
    raw: null,
  });
  await maybeComplete(jobId);
}

/**
 * Starts one Worker per provider pool.
 *
 * Each pool gets its own connection and its own concurrency, so Gmail's pool of
 * 2 cannot be starved or amplified by the `other` pool of 8.
 */
export async function startWorkers(): Promise<void> {
  if (workers.size > 0) return;
  const settings = await getSettings(true);

  /**
   * How long a job's lock is held before BullMQ treats the worker as dead.
   *
   * This is a real trade-off, not a magic number. It must comfortably exceed the
   * longest *legitimate* time a single address can take — the pacer wait plus a
   * full Reacher timeout — or healthy slow checks get reclaimed and processed
   * twice. But it is also the floor on how long a crashed run takes to recover:
   * jobs that were in flight when the process died stay stuck in `active` until
   * the lock expires.
   *
   * Deriving it from the configured timeout keeps both properties: ~2.5x the
   * timeout plus a minute of headroom. With the default 45s timeout that means
   * in-flight work is reclaimed about 2.5 minutes after a crash, instead of the
   * 5 minutes a flat 300s would cost.
   */
  const lockDuration = Math.max(120_000, settings.reacherTimeoutMs * 2 + 60_000);

  for (const group of PROVIDER_GROUPS) {
    const worker = new Worker<VerifyJobData>(queueName(group), process, {
      connection: createQueueConnection(),
      concurrency: settings.groups[group].concurrency,
      lockDuration,
      // Check for abandoned jobs reasonably often so a restart recovers quickly.
      stalledInterval: 30_000,
      maxStalledCount: 2,
    });

    worker.on('failed', (job, err) => {
      console.error(
        `[worker:${group}] unexpected failure for ${job?.data.email ?? '?'}: ${err.message}`,
      );
    });
    worker.on('error', (err) => {
      console.error(`[worker:${group}] error:`, err.message);
    });

    workers.set(group, worker);
    console.log(
      `[worker:${group}] started concurrency=${settings.groups[group].concurrency} ` +
        `delay=${settings.groups[group].delayMs}ms`,
    );
  }

  // Poll settings so concurrency changes from the UI apply to a running job
  // without a restart. BullMQ's concurrency setter takes effect on the next
  // fetch cycle. The pacing delay needs no wiring: the processor reads it on
  // every address.
  concurrencyTimer = setInterval(() => {
    void (async () => {
      try {
        const s = await getSettings();
        for (const group of PROVIDER_GROUPS) {
          const w = workers.get(group);
          if (!w) continue;
          const target = s.groups[group].concurrency;
          if (w.concurrency !== target) {
            console.log(`[worker:${group}] concurrency ${w.concurrency} -> ${target}`);
            w.concurrency = target;
          }
        }
      } catch (err) {
        console.warn('[worker] concurrency sync failed:', (err as Error).message);
      }
    })();
  }, 2_000);
}

export async function stopWorkers(): Promise<void> {
  if (concurrencyTimer) {
    clearInterval(concurrencyTimer);
    concurrencyTimer = null;
  }
  await Promise.all([...workers.values()].map((w) => w.close()));
  workers.clear();
}
