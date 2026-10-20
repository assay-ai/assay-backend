# BullMQ as a wakeup mechanism, not a retry engine

**Status:** accepted
**Date:** 2026-05-25

This backend treats BullMQ as a *wakeup signal* — a transient "go look at this row" message — rather than as the canonical retry-and-recovery engine for background work. The database row in your feature table is the single source of truth for job state; BullMQ jobs can be lost, duplicated, or replayed without consequence, because the worker performs a CAS claim before doing anything.

This shapes three concrete choices that follow from the same principle:

1. **`attempts: 1`** on every CAS state-machine queue (default in `bullmq.config.ts`).
2. **Recovery via cron**, not via BullMQ retry — a `lock_expires_at` column + sweeper.
3. **Feature modules split into shared / api / worker sub-modules**, so processors only instantiate in the worker process.

## The pattern

A "CAS state-machine job" in this template means a feature whose background work follows this shape:

- The feature owns a DB table (`{table}`) with at least: `status`, `locked_by`, `locked_at`, `lock_expires_at`.
- States typically include `pending`, an active region (`locked`, `processing`, …), and terminal states (`completed`, `failed`).
- The worker transitions `pending → locked` via a SQL `UPDATE ... WHERE status='pending'` — exactly one worker wins, the others see zero affected rows and **drop the wakeup**.
- A cron sweeper (running in the worker process via `@nestjs/schedule`, once that's introduced) resets rows whose `lock_expires_at < now()` back to `pending`. The wakeup is re-enqueued from the sweep; the next worker that picks it up resumes.

Layering BullMQ retries on top of this would create two recovery mechanisms, each partial, each invisible to the other. Debugging an incident would require correlating BullMQ job state with row state — a known operational hazard.

## Decision

### 1. Convention: attempts per queue type

| Queue type | `attempts` | Recovery |
|---|---|---|
| CAS state-machine (DB row is source of truth) | **1** | Cron release + cron kill-switch |
| Stateless idempotent (push notification, external sync, …) | **3** + exponential backoff | BullMQ retry |

Default is `attempts: 1` in `bullmq.config.ts`. Publishers for stateless jobs override per-call (see `DemoPingPublisher` for the pattern). The demo intentionally uses the stateless convention so the reference shows both code paths.

### 2. Processor contract for CAS jobs

A CAS state-machine processor MUST NEVER throw:

- **Lost the CAS claim** (another worker took the row, or row is no longer `pending`) → log, return success. The wakeup is consumed; the row state is correct.
- **External call failed** (downstream provider, storage, etc.) → set `status='failed'` + `error_code` in the DB, return success.
- **Worker crashed mid-pipeline** → BullMQ job may be lost. Doesn't matter: cron release detects `lock_expires_at < now`, resets the row to `pending`, and re-enqueues the wakeup. If the failed call had an external request id (e.g. an upstream API request id), persist it on the row before crashing so the next worker can reuse it and trigger upstream deduplication.

### 3. jobId for idempotency

CAS publishers set `jobId = {entityId}`. This makes both code paths (API enqueue at row creation, cron re-enqueue after release) idempotent — duplicate wakeups collapse into one BullMQ job. Stateless publishers pick whatever id makes sense for them (e.g. a timestamp); duplication tolerance differs per use case.

### 4. Module split: shared / api / worker

A common NestJS misconception: *"a feature module can be safely imported into both bootstraps; Nest only instantiates classes whose dependencies resolve"*. **This is not true for `@Processor()`.** When Nest instantiates a `@Processor()` class, `@nestjs/bullmq` immediately creates a BullMQ `Worker` and starts consuming from Redis. The same applies to `@nestjs/schedule`'s `@Cron()` — schedulers boot on instantiation.

If a feature module containing the processor is imported by `AppApiModule`, the api process becomes an unintended consumer. It would steal CAS claims and tie up its HTTP threads on long-running background calls.

To prevent this, every feature module that owns background work is split into three Nest modules:

```
src/modules/{feature}/
├── {feature}.module.ts             SHARED — service, publisher, repository,
│                                   BullModule.registerQueue() + re-export
├── {feature}-api.module.ts         API-only — controller + registerQueueOnBoard()
└── {feature}-worker.module.ts      WORKER-only — processor + cron + imports {feature}.module
```

Subtle pairing — discovered during scaffold smoke-test:
- `BullModule.registerQueue` belongs in the SHARED module (both sides need queue access — the api to publish, the worker to consume). The shared module MUST also re-export `BullModule` so the api side can resolve the queue token for Bull Board's `forFeature`.
- `BullBoardModule.forFeature` (via `registerQueueOnBoard()` from `@shared/queue`) belongs in `*-api.module.ts` ONLY. It depends on `bull_board_instance` from the api-only `forRootAsync`, and instantiating it inside a worker-bound module crashes Nest's DI at boot.

- `AppApiModule` imports only `*-api.module.ts` modules.
- `AppWorkerModule` imports only `*-worker.module.ts` modules.
- The shared `*.module.ts` provides the publisher to both sides (the api enqueues from the controller; the worker enqueues from the cron sweeper).

`src/modules/notification/` is a reference implementation of this split.

## Alternatives considered

### A. Keep `attempts: 3` BullMQ retry + cron release ("belt + suspenders")

Rejected. Transient failures BullMQ retry can actually rescue are rare (provider rate-limits and outages don't clear in 3 seconds; worker crashes can't be rescued by BullMQ at all). The two recovery layers obscure each other in incident analysis, and external-provider double-charging via mismatched request ids becomes a real risk. Add a `release_count` observability column to drive a future decision to add a single BullMQ retry — start narrow, widen with data.

### B. Central `src/queue/` directory

Rejected for typical scale. Centralization pays off when many unrelated queues share scaffolding (e.g. blockchain events + embedding pipeline + video gen). A typical app has one or two core queues plus a handful of cron sweepers, all belonging to a small set of features. Feature-locality wins. Shared *primitives* (base class, exception, helper) still live in `src/shared/queue/`.

### C. Single feature module via `forApi()` / `forWorker()` dynamic module pattern

Rejected. Halves the file count but obscures the intent for readers using the demo module as a template. With sub-module split, "what runs in api?" is `grep "imports.*-api.module"`. With dynamic modules, you have to read the module factory.

## Consequences

- Every feature with background work has 3 module files instead of 1. Boilerplate cost is real but bounded; the demo module is the copy-paste template.
- `@nestjs/schedule` runs in its own `scheduler` bootstrap in this backend (a deliberate deviation from the original template, which had no scheduler and hosted cron in the worker). Cron sweepers therefore go in a `*-scheduler.module.ts`, and `AppSchedulerModule` mounts the BullMQ root so a sweeper can re-enqueue wakeups. The api process imports neither processors nor crons. Note the scheduler must run as a **single instance** — see `docs/architecture.md`.
- Bull Board (mounted on the api server at `/api/admin/queues`) shows queues that any `*-api.module.ts` opts into via `registerQueueOnBoard()`. Worker-only queues are not visible — such a queue opts in to dashboard visibility by adding a corresponding api-side stub module that exists solely to call `registerQueueOnBoard`. `src/websocket/websocket-board.module.ts` is the worked example: the `websocket.events` queue is consumed by the websocket process, so nothing on the api side would otherwise register it.
- Env-gated module imports must be written INLINE in the `imports` array after `ConfigModule.forRoot(...)`. `process.env` reads from top-of-file constants resolve before `.env` is loaded, silently disabling the module.
- BullMQ job ids cannot contain `:` (Redis key separator). Publishers that compose job ids must use `-` or another safe delimiter.
