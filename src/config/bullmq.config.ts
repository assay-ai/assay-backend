import { registerAs } from '@nestjs/config';

/**
 * BullMQ root configuration.
 *
 * Each NestJS process (api / worker) opens one BullMQ connection from this
 * config. `connectionName` makes the two processes distinguishable in
 * `redis-cli CLIENT LIST` during ops work.
 *
 * Default `attempts: 1` enforces the project-wide convention: BullMQ acts as a
 * wakeup signal, not a retry engine. CAS state-machine jobs keep this default
 * — recovery from worker crashes is handled by the cron release sweeper, not
 * BullMQ retries. Stateless idempotent jobs (notifications, sync, etc.)
 * override per-publisher with `attempts: 3` + exponential backoff.
 *
 * See `docs/adr/0001-bullmq-as-wakeup-mechanism.md`.
 */
export const bullmqConfig = registerAs('bullmq', () => ({
  connection: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT, 10),
    password: process.env.REDIS_PASSWORD || undefined,
    connectionName: `app-${process.env.NODE_ENV ?? 'development'}-${process.env.SERVICE_TYPE ?? 'unknown'}`,
  },
  // Namespaces BullMQ keys in Redis: `${prefix}:{queue-name}:*`. Override
  // per-env when multiple environments share a single Redis instance.
  prefix: process.env.BULLMQ_PREFIX || 'app',
  defaultJobOptions: {
    attempts: 1,
    backoff: { type: 'exponential' as const, delay: 5000 },
    // Retain by count AND age — whichever limit hits first. Failed jobs kept
    // longer than completed so operators can inspect via Bull Board.
    removeOnComplete: { count: 1000, age: 24 * 3600 },
    removeOnFail: { count: 5000, age: 7 * 24 * 3600 },
  },
}));
