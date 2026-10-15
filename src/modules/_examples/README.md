# `_examples/` — starter reference modules

These are the NestJS starter's sample modules. **They are not product code and
nothing here should be imported by a domain module.** They are kept because a
working module is faster to read than prose when you need to remember how this
template wires a particular piece of infrastructure.

They are quarantined here, behind a flag, rather than deleted — deleting them
costs nothing today and costs a re-derivation every time someone needs the
answer later. A separate goal removes them once nobody is consulting them.

## What each one demonstrates

| Module      | Read it when you need                                                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `posts/`    | The **full feature pattern**: a BullMQ-split module trio (`posts.module` shared / `posts-api.module` / `posts-worker.module`), a typed publisher + processor pair, a paginated query builder, an error catalog, DTO-per-endpoint, and `WebSocketEmitterService` emitting from a service. |
| `demo/`     | The **minimal** version of that same trio — the smallest thing that proves BullMQ + Bull Board wiring end to end (`POST /api/v1/demo/ping`). Start here, not in `posts/`.                                                                                                                |
| `auth/`     | Passport JWT registration: `JwtStrategy`, `JwtModule.registerAsync` reading `jwt.config`, and the `JwtAuthGuard` in `@shared/guards`.                                                                                                                                                    |
| `schedule/` | An `@nestjs/schedule` `@Cron` job that injects a repository — the scheduler-process pattern.                                                                                                                                                                                             |

Two more sample files stay outside this folder because they are registered with
the TypeORM infrastructure rather than with a module:
`src/database/postgres/entities/post.entity.ts` and
`src/database/postgres/repositories/post.repository.ts`. They are the reference
for the Entity and Repository patterns in `docs/architecture.md`.

## The flag

Loading is controlled by `EXAMPLES_ENABLED`:

- unset → **on** outside production, **off** when `NODE_ENV=production`
- set → the explicit value wins, in every environment

Each service bootstrap imports exactly one grouping module —
`ExamplesApiModule`, `ExamplesWorkerModule`, `ExamplesSchedulerModule` — behind
that flag, so the examples appear and disappear as one unit and never leave a
half-loaded processor consuming a queue.

With the flag off, `POST /api/v1/demo/ping` returns 404: the controller is not
mounted at all.

## Rules

- **Do not import from `_examples/` outside `_examples/`.** The folder is meant
  to be deletable in one commit.
- **Do not "improve" these modules.** They earn their keep by being the code the
  template actually shipped. Changing them to match new conventions turns the
  reference into a second, subtly different source of truth.
- New feature work goes in a domain module (`payment/`, `ledger/`, …), following
  `docs/architecture.md` — not here.
