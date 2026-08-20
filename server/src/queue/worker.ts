import { Worker, type Job } from 'bullmq';
import { createQueueConnection } from '../redis.js';
import { getSettings } from '../settings.js';
import { classify } from '../lib/classify.js';
import { acquireSlot } from '../lib/pacer.js';
import {
  ReacherHttpError,
  ReacherUnavailableError,
  checkEmail,
  type ReacherResponse,
} from '../lib/reacher.js';
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

  const parent = await getJob(jobId);
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

  let response: ReacherResponse | null = null;
  let transportError: { reason: Reason; message: string } | null = null;

  try {
    response = await checkEmail(email, settings.reacherTimeoutMs);
  } catch (err) {
    if (err instanceof ReacherUnavailableError) {
      // Sidecar timeout/network errors say nothing about the mailbox.
      transportError = { reason: 'connection_error', message: err.message };
    } else if (err instanceof ReacherHttpError) {
      if (err.status === 429 || err.status >= 500) {
        transportError = { reason: 'connection_error', message: `${err.message}: ${err.body}` };
      } else {
        // Bad request, licence, or shared-secret misconfiguration. Preserve a
        // useful error rather than wasting retry attempts.
        console.error(`[worker:${group}] Reacher rejected the request: ${err.message} ${err.body}`);
        transportError = { reason: 'reacher_error', message: `${err.message}: ${err.body}` };
      }
    } else {
      transportError = { reason: 'connection_error', message: (err as Error).message };
    }
  }

  if (transportError) {
    const permanent = transportError.reason === 'reacher_error';
    if (!permanent && attempt < maxAttempts) {
      const delayMs = settings.retryBackoffMs[attempt - 1] ?? settings.retryBackoffMs.at(-1) ?? 30_000;
      await incrTempFailEvents(jobId);
      await requeueWithBackoff(job.data, attempt + 1, delayMs);
      return;
    }
    await recordResult({
      jobId,
      email,
      domain,
      group,
      category: 'unknown',
      reason: permanent ? 'reacher_error' : 'temp_fail_exhausted',
      reacherStatus: null,
      attempts: attempt,
      smtpCode: null,
      message: transportError.message,
      raw: null,
    });
    await maybeComplete(jobId);
    return;
  }

  const verdict = classify(response!, settings);

  if (verdict.kind === 'temp_fail') {
    await incrTempFailEvents(jobId);

    if (attempt < maxAttempts) {
      const delayMs = settings.retryBackoffMs[attempt - 1] ?? settings.retryBackoffMs.at(-1) ?? 30_000;
      await requeueWithBackoff(job.data, attempt + 1, delayMs);
      return;
    }

    await recordResult({
      jobId,
      email,
      domain,
      group,
      category: 'unknown',
      reason: 'temp_fail_exhausted',
      reacherStatus: typeof response!.is_reachable === 'string' ? response!.is_reachable : null,
      attempts: attempt,
      smtpCode: verdict.smtpCode,
      message: verdict.message,
      raw: response,
    });
    await maybeComplete(jobId);
    return;
  }

  await recordResult({
    jobId,
    email,
    domain,
    group,
    category: verdict.category,
    reason: verdict.reason,
    reacherStatus: typeof response!.is_reachable === 'string' ? response!.is_reachable : null,
    attempts: attempt,
    smtpCode: verdict.smtpCode,
    message: verdict.message,
    raw: response,
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
