import { Redis } from 'ioredis';
import { config } from './config.js';

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connections it uses for
 * blocking commands, so we share that option everywhere for consistency.
 */
function make(): Redis {
  const client = new Redis(config.redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  client.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
  });
  return client;
}

/** General purpose connection: counters, settings, MX cache, pacing. */
export const redis = make();

/** Dedicated connection handed to BullMQ queues/workers. */
export function createQueueConnection(): Redis {
  return make();
}

export const keys = {
  settings: 'ezd:settings',
  jobCounts: (jobId: string) => `ezd:job:${jobId}:counts`,
  jobCancelled: (jobId: string) => `ezd:job:${jobId}:cancelled`,
  dispatchLock: (jobId: string) => `ezd:job:${jobId}:dispatch-lock`,
  pace: (group: string) => `ezd:pace:${group}`,
  mx: (domain: string) => `ezd:mx:${domain}`,
};
