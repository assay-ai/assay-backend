# Backend architecture and conventions

This document describes how the backend is put together and the conventions every change is
expected to follow. Setup, commands and the pull-request flow are in
[`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Project Overview

A NestJS multi-service backend. One image runs one of several process roles, selected by the
`SERVICE_TYPE` environment variable: `api`, `websocket`, `scheduler`, `worker`, `mcp`,
`facilitator`, or `all` for local development.

**Tech stack:** NestJS 11, TypeORM, PostgreSQL 15, Redis 7, BullMQ + Bull Board, Socket.IO,
Swagger, `@solana/kit` and `viem` behind the chain boundary.

## Architecture

```
src/
├── bootstrap/          # Service entry points, one per SERVICE_TYPE
├── bull-board/         # Bull Board dashboard mount (api-only)
├── config/             # Configuration factories (app, database, redis, bullmq, auth, ...)
├── database/postgres/  # Entities, repositories, migrations, organization-scope guard
├── modules/            # Domain modules — payment, ledger, tool, provider,
│                       #   verification, settlement, mcp, ... and the chains/ boundary
├── shared/             # Shared utilities, filters, guards, interceptors, DTOs, queue primitives
├── websocket/          # WebSocket gateway, processor and services
└── main.ts             # Entry point (delegates to bootstrap based on SERVICE_TYPE)
packages/
└── settlement-client/  # Generated @solana/kit client for the settlement program
```

## Scaling Design

- **Scheduler:** Must run as a **single instance only** — running multiple instances would cause duplicate job execution.
- **API, Worker, WebSocket, MCP:** Can run **multiple instances** for horizontal scaling.
- **Facilitator:** Its own process, so the fee-payer signer's credentials are never in the API's address space.
- **Worker concurrency:** capped via `WORKER_CONCURRENCY` (default 4) to protect downstream rate limits. Individual processors may override with `@Processor(name, { concurrency })`.

## Path Aliases

| Alias | Path |
|-------|------|
| `@config/*` | `src/config/*` |
| `@database/*` | `src/database/*` |
| `@modules/*` | `src/modules/*` |
| `@shared/*` | `src/shared/*` |
| `@constants/*` | `src/shared/constants/*` |
| `@decorators/*` | `src/shared/decorators/*` |
| `@exceptions/*` | `src/shared/exceptions/*` |
| `@filters/*` | `src/shared/filters/*` |
| `@utils/*` | `src/shared/utils/*` |
| `@bootstrap/*` | `src/bootstrap/*` |
| `@websocket/*` | `src/websocket/*` |

## Naming Conventions

- **Files:** kebab-case (e.g., `tool-request.entity.ts`, `tool-requests.controller.ts`)
- **Classes:** PascalCase (e.g., `PostEntity`, `PostsService`)
- **Variables/functions:** camelCase
- **Constants/enums:** UPPER_SNAKE_CASE
- **Database columns:** snake_case with explicit `@Column({ name: 'snake_case' })`
- **TypeScript properties:** camelCase mapping to snake_case columns
- **Table names:** plural snake_case via `@Entity('table_name')`
- **Controller routes:** plural kebab-case via `@Controller('resource-name')`
- **Index names:** `idx_{table}_{column}` (e.g., `idx_posts_title`)

## Module Structure Pattern

```
src/modules/{module-name}/
├── constants/
├── controllers/
│   └── {module-name}.controller.ts
├── dto/
│   ├── get-{resource}s.dto.ts
│   ├── get-{resource}-by-id.dto.ts
│   └── create-{resource}.dto.ts
├── errors/
│   └── {module-name}.errors.ts
├── services/
│   └── {module-name}.service.ts
└── {module-name}.module.ts
```

Domain modules, plus `chains/`, are the only modules that belong directly under
`src/modules/`.

`chains/` is not a domain — it is the boundary. It owns every chain-specific type, string
format and SDK, and nothing else may import one: ESLint's `no-restricted-imports` fails the
build on `@solana/*`, `@solana-program/*`, `viem`, `ethers` and friends anywhere else under
`src/`. The domain talks to it through `ChainAdapterRegistry` and the ports in
`chains/ports/`.

**Which chains a deployment serves is `ENABLED_CHAINS`, and it is fail-closed.**
A comma-separated list of CAIP-2 ids, read once at boot by `chains.module.ts`.
Absent, empty, malformed, or naming a chain with no adapter, the process
**exits** — `CHAIN_ENABLED_CHAINS_INVALID` naming the offending value and
listing what is actually served. It narrows the adapter registry,
the reconciler's asset list and the router's eligibility filter from one place,
so there is no second list to forget. Operating it — adding a chain, removing
one, and what removing one does to balances already held on it — is
[`docs/runbooks/chains.md`](runbooks/chains.md).

See `src/modules/tool-request/` for a small, complete example of this layout.

## Multi-Organization Scoping (Important)

Every business table carries `organizationId`. It was enforced before the tables existed,
because retro-fitting it across twenty tables is a system-wide migration plus a rewrite of every
query written in between.

- **Entities** extend `OrganizationScopedEntity`, or
  `OrganizationScopedEntityWithoutSoftDelete` for financial records, which are
  never soft-deleted. Both carry `organizationId` and its index.
- **Repositories** extend `OrganizationScopedRepository<Entity>`. Every read,
  write and query builder must constrain `organizationId`; one that does not
  rejects with `ORGANIZATION_SCOPE_MISSING` before the statement reaches
  Postgres.
- A bare primary key is **not** valid criteria — pass `{ organizationId, id }`.
  An id belongs to *some* organization; acting on it without naming which one is
  how a row gets written across a tenant boundary. This is a compile error as
  well as a runtime one.
- `updateAll`, `deleteAll`, `clear()`, `query()`, `findByIds` and `findOneById`
  have no scoped form and are refused outright.

The query-builder check reads the built SQL for `organization_id`. It proves the
column is referenced, not that it is bound to the caller's own organization — it
stops the accident, not the deliberate act.

Reference: `src/database/postgres/organization-scope/`,
`src/database/postgres/repositories/organization-scoped.repository.ts`.

## Entity Pattern

- Extend `OrganizationScopedEntity` for business tables (see above). Extend
  `AbstractEntity` only for tables that genuinely belong to no organization
- `AbstractEntity` provides UUID PK, `createdAt`, `updatedAt`, soft delete via `deletedAt`, optimistic locking via `version`
- Use the `WithoutSoftDelete` variant for tables where soft delete is not needed
- Use `@Entity('plural_snake_case_table_name')`
- Use `@Column({ name: 'snake_case_column' })` for explicit column mapping
- Add `@Index('idx_{table}_{column}')` for frequently queried columns
- Place entity files in `src/database/postgres/entities/`

Reference: `src/database/postgres/entities/tool-request.entity.ts`

## Repository Pattern

- Extend `OrganizationScopedRepository<Entity>` for business tables, or
  `AbstractRepository<Entity>` for the rare table that belongs to no organization
- Decorate with `@Injectable()`
- Inject `DataSource` via `@InjectDataSource('postgres')`
- Call `super(Entity, dataSource)` in constructor
- Place in `src/database/postgres/repositories/`
- Available batch operations: `batchInsertWithSplit`, `batchUpsertWithSplit`, `batchInsertOrUpsertWithSplit`
- Register in `postgres.module.ts` (add to `entities` and `repositories` arrays)
- Export from `src/database/postgres/index.ts`

Reference: `src/database/postgres/repositories/tool-request.repository.ts`

## Service Pattern

- Decorate with `@Injectable()`
- Contains all business logic
- Inject repositories, other services, publishers via constructor
- Methods return DTOs, not raw entities (use a private `mapToResponseDto` method)
- Throw errors using the module's error factory (e.g., `PaymentErrors.paymentIntentNotFound({ id })`)
- Use `async/await` throughout
- Add `private readonly logger = new Logger(ClassName.name)`

Reference: `src/modules/tool-request/services/tool-request.service.ts`

## Controller Pattern

- Thin controllers that delegate all logic to services
- `@Controller('resource-name')` with plural kebab-case
- `@ApiTags('ResourceName')` for Swagger grouping
- `@ApiOperation({ summary })` on every endpoint
- `@ApiResponse({ status, description, type })` with DTO types
- RESTful routes: `GET` (list), `GET /:id`, `POST`, `PUT /:id`, `PATCH /:id`, `DELETE /:id`
- Responses are auto-transformed by `TransformInterceptor` into `{ data, statusCode, message }`

Reference: `src/modules/tool-request/controllers/tool-requests.controller.ts`

## DTO Pattern

- One file per endpoint: `{action}-{resource}.dto.ts` (e.g., `update-spend-policy.dto.ts`)
- Each file contains ALL DTOs for that endpoint (Query, Body, Params, Response)
- Use classes with `class-validator` decorators (`@IsString`, `@IsNotEmpty`, `@IsUUID`, etc.)
- Use `@ApiProperty` / `@ApiPropertyOptional` for Swagger documentation
- List query DTOs extend `ListQueryDto` from `@shared/api/dto/list-query.dto`

Reference: `src/modules/tool-request/dto/`

## Error System (Important)

The error system provides type-safe, structured error handling across the entire application.

### Architecture

```
BaseError (abstract)                    # src/shared/errors/base.error.ts
  └── AppError                          # src/shared/errors/app-errors.ts
        └── created via createDomainErrorFactory()   # src/shared/errors/error-catalog.ts

AllExceptionsFilter                     # src/shared/filters/all-exceptions.filter.ts
  @Catch() — the ONLY filter. Every exception, from any layer, leaves as
  ErrorResponse. Do NOT register a second one.
```

One filter, one response shape: callers never have to parse two shapes and guess which they
have.

### Error Response Format

Every failure — a domain `AppError`, a framework `HttpException`, a 404 for a
route that does not exist, an unhandled `TypeError` — returns exactly this and
nothing else. There are no optional members; validation failures fold their
per-field messages into `message` rather than adding a branch.

```json
{
  "success": false,
  "error": {
    "code": "PAYMENT_INTENT_NOT_FOUND",
    "message": "Payment intent not found with id: abc-123",
    "statusCode": 404,
    "path": "/api/v1/payments/abc-123",
    "timestamp": "2026-08-12T16:38:15.638Z"
  }
}
```

Framework failures carry an HTTP-level code (`NOT_FOUND`, `VALIDATION_FAILED`,
`INTERNAL_SERVER_ERROR`, …) from `HttpErrorCode`; domain failures carry their own
prefixed code.

### Creating Module Errors

Each domain owns a prefix, declares its codes as an enum, and builds its factory
with `createDomainErrorFactory`:

```typescript
import { AssertDomainErrorCodes, createDomainErrorFactory } from '@shared/errors/error-catalog';

export enum PaymentErrorCode {
  PAYMENT_INTENT_NOT_FOUND = 'PAYMENT_INTENT_NOT_FOUND',
}

// Fails `yarn build` if a member is added without the prefix.
export type PaymentErrorCodesArePrefixed = AssertDomainErrorCodes<'PAYMENT', `${PaymentErrorCode}`>;

export const PaymentErrors = createDomainErrorFactory('PAYMENT', {
  paymentIntentNotFound: {
    code: PaymentErrorCode.PAYMENT_INTENT_NOT_FOUND,
    statusCode: 404,
    message: (context?: Record<string, any>) =>
      `Payment intent not found${context?.id ? ` with id: ${context.id}` : ''}`,
  },
});
```

The prefix is enforced twice: at compile time by `AssertDomainErrorCodes`, and at
import time by `createDomainErrorFactory`, which throws at boot rather than on
the first request that raises the code.

| Domain | Prefix |
|---|---|
| `payment` | `PAYMENT_*` |
| `ledger` | `LEDGER_*` |
| `tool` | `TOOL_*` |
| `provider` | `PROVIDER_*` |
| `verification` | `VERIFICATION_*` |
| `settlement` | `SETTLEMENT_*` |
| `mcp` | `MCP_*` |
| `chains` | `CHAIN_*` |
| query-scope guard (shared) | `ORGANIZATION_*` |
| `Money` arithmetic (shared) | `MONEY_*` |

### Throwing Errors

Always throw from **services**, never from controllers:
```typescript
throw PaymentErrors.paymentIntentNotFound({ id });       // 404
throw PaymentErrors.voucherSeqAlreadyUsed({ account });  // 409
```

The factory returns a typed function — calling it creates an `AppError` that
`AllExceptionsFilter` serialises into the shape above.

### Key Files

| File | Purpose |
|------|---------|
| `src/shared/errors/base.error.ts` | Abstract base class with `errorCode`, `statusCode`, `isOperational`, `toJSON()` |
| `src/shared/errors/app-errors.ts` | `AppError` class + `createErrorFactory()` — the factory pattern |
| `src/shared/errors/error-catalog.ts` | `createDomainErrorFactory()` + `AssertDomainErrorCodes` — prefix enforcement |
| `src/shared/errors/error-response.ts` | The `ErrorResponse` contract and `HttpErrorCode` |
| `src/shared/filters/all-exceptions.filter.ts` | The single global filter |

### Rules

- **One error file per module** — `errors/{module-name}.errors.ts`
- **Throw from services only** — controllers are thin, they don't handle errors
- **Always pass context** — include relevant IDs/values so error messages are actionable
- **Use correct HTTP status codes** — 404 (not found), 400 (bad request), 409 (conflict), 500 (server error)
- **Never catch AppError in services** — let it bubble up to the filter
- **Error codes are UPPER_SNAKE_CASE and domain-prefixed** — enum member and value are identical, so a code from a log is greppable
- **Never register a second global filter** — `AllExceptionsFilter` already catches everything

Reference: `src/modules/payment/errors/payment.errors.ts`

## Queue Pattern (BullMQ)

Queues are **feature-local**, not centralised. A feature that owns background work
splits into three Nest modules so that `@Processor()` classes only ever
instantiate in the worker process:

```
src/modules/{feature}/
├── constants/{feature}-queues.constant.ts   # enum: `<entity>.<verb>` queue names
├── publishers/{queue}.publisher.ts          # @InjectQueue + typed job-data interface
├── processors/{queue}.processor.ts          # @Processor, extends QueueProcessorBase
├── {feature}.module.ts                      # SHARED — service, publisher,
│                                            #   BullModule.registerQueue() + re-export
├── {feature}-api.module.ts                  # API-only — controller + registerQueueOnBoard()
└── {feature}-worker.module.ts               # WORKER-only — processor (+ cron)
```

Rules:
- `AppApiModule` imports only `*-api.module.ts`; `AppWorkerModule` imports only `*-worker.module.ts`.
- `BullModule.registerQueue` belongs in the SHARED module and MUST be re-exported.
- `registerQueueOnBoard()` (from `@shared/queue`) belongs in `*-api.module.ts` ONLY —
  it depends on the api-only Bull Board root and crashes the worker at boot otherwise.
- Processors extend `QueueProcessorBase` from `@shared/queue` for scoped logging + `onFailed`.
- Global default is `attempts: 1` (BullMQ is a wakeup signal, not a retry engine).
  Stateless idempotent jobs override per-publisher with `attempts: 3` + backoff.
- Job ids cannot contain `:` — use `-`.

Reference: `src/modules/notification/` (publisher, processor, and the api/worker split).
Rationale: [`docs/adr/0001-bullmq-as-wakeup-mechanism.md`](adr/0001-bullmq-as-wakeup-mechanism.md).

Bull Board is mounted on the API server at `/api${BULLBOARD_PATH}` (default
`/api/admin/queues`) behind HTTP basic auth, gated by `BULLBOARD_ENABLED`. Set a strong
`BULLBOARD_PASSWORD` on any deployment where it is enabled.

## WebSocket Pattern

- Gateways extend `BaseGateway`
- `WebSocketEmitterService` publishes events onto the `websocket.events` BullMQ queue
  (provided globally, so api / worker / scheduler can all emit)
- `WebSocketEventsProcessor` drains that queue in the websocket process and hands
  each message to `WebSocketRelayerService`, which broadcasts to connected clients
- Fan-out across multiple websocket instances is handled by the Socket.IO Redis adapter
- WebSocket module in `src/websocket/`

## OpenAPI Export Pattern

`openapi.yaml` is generated on demand from `AppApiModule` via `yarn openapi:export`
(runs `scripts/export-openapi.ts`, boots the api module in memory, calls
`SwaggerModule.createDocument()`, dumps YAML to disk). It needs a populated `.env`.

The file is not committed — wire the export into your client's build, or commit
it behind a CI drift guard, depending on how the contract is consumed.

Note: `scripts/` **and `packages/`** are excluded from `tsconfig.build.json`. Without
those exclusions TypeScript widens `rootDir` to the project root and emits
`dist/src/main.js`, which breaks `start:prod` and every `migration:*` script —
the symptom is a `dist/` containing `src/` and `packages/` instead of `main.js`.

## The Settlement Client (`packages/settlement-client`)

The Anchor settlement program's interface is **generated, never hand-written**.
`@assay/settlement-client` is a yarn workspace package holding Codama output
rendered from the program's IDL, which `anchor idl build` renders from the
program source in the `assay-solana` repository. The IDL is vendored at
`packages/settlement-client/idl/assay_payment.json`.

```bash
yarn client:generate     # re-render src/generated/ from idl/assay_payment.json
yarn client:check        # CI gate: fails if the two disagree
yarn client:build        # tsc -> packages/settlement-client/dist
```

The doc comments in `src/generated/` come from the IDL, which in turn comes from the
program source. Replacing the vendored IDL with a fresh build from the contract repository
and regenerating will overwrite them.

Rules:

- **Never build an instruction for that program by hand.** Use
  `get<Name>Instruction[Async]`, `fetch<Name>` / `get<Name>Decoder()`,
  `find<Name>Pda`, `getAssayPaymentErrorMessage`. Two locks enforce this: an
  ESLint `no-restricted-syntax` rule under `src/`, and
  `test/unit/chains/solana/settlement-client-only.spec.ts`, which also covers
  `scripts/` (ESLint ignores that directory).
- **It is a chain SDK and lives behind the `chains/` boundary.** ESLint bans
  importing it outside `src/modules/chains/`, on the same rule as `@solana/*`.
- **It is a real dependency with a real build**, resolved through
  `node_modules` rather than a tsconfig path alias — a path alias would pull its
  sources into `nest build` and widen `rootDir` again. So `yarn build` and
  `yarn test` both run `client:build` first, and the Dockerfile copies
  `packages/settlement-client/package.json` before `yarn install` and its `dist`
  into the runtime stage.
- **`src/generated/` is committed and must not be edited.** `yarn client:check`
  re-renders and diffs in both directions, so an edit is a red pipeline.
- **Three files are hand-written, and each is checked against the IDL.**
  - `src/record-pdas.ts`, because `@codama/renderers-js` resolves neither a PDA
    seed whose `arg` path points inside a struct (`attestation.request_id`, on
    `propose_slash`) nor one whose `account` path points at the account being
    derived (`slash_record.request_id`, on `cancel_slash`, `execute_slash` and
    `expire_slash`). Plain const seeds (`["config"]`, `["stake_vault"]`, …)
    Codama does render, so there is deliberately no copy of any of them here.
    Checked by `test/unit/chains/solana/record-pda-seeds.spec.ts`.
  - `src/attestation-message.ts` and `src/voucher-message.ts` — the two signed
    messages, which are neither instructions nor accounts and so appear nowhere
    in the IDL: the verifier's slash attestation (210 bytes) and the buyer's
    voucher (239 bytes). Checked by `attestation-message.spec.ts` /
    `voucher-message.spec.ts`, and by the chain refusing a wrong encoding outright.
  - `src/program-constants.ts` — `SLASH_DELAY_SECONDS` (72h) and
    `WITHDRAW_DELAY_SECONDS` (1h). Codama renders no constants at all, so a reader
    who wants them has nowhere else to go. Checked against the IDL's own
    `constants` array by `test/unit/chains/solana/program-constants.spec.ts`.
    **Nothing may hardcode 72 or 3600.**

Deployment, upgrade authority and the IDL drift gates are documented in the
`assay-solana` repository.

To exercise every instruction against a live cluster:

```bash
yarn settlement:exercise localnet     # or devnet
```

## Cache Pattern

- `CacheService` from `@shared/cache/redis-cache/cache.service`
- Cache key constants in `@shared/constants/cache-keys.constant`
- HTTP-level caching via `@HttpCacheTTL` decorator

## Feature Flags

One group of routes is gated, and it **fails closed**: unset means on outside
production and off when `NODE_ENV=production`; an explicit value wins everywhere.

| Flag | Gates | Helper |
|---|---|---|
| `DIAGNOSTICS_ENABLED` | `GET /api/v1/diagnostics/errors/:domain`, the error-contract probe | `areDiagnosticsEnabled()` |

Call the helper INLINE in the bootstrap `imports` array, after
`ConfigModule.forRoot(...)` — see "Bootstrap Registration".

## Signing Keys (Important)

**Private keys are provisioned through environment variables for now, and every
one of them sits behind a port so that swapping in a KMS is a new class and one
line of wiring.** The target for a production deployment is that no private key
material is ever in an environment variable, a config file, or a container image.
That is the target, not the current state.

### The decision

A managed custody service — AWS KMS, Turnkey, HashiCorp Vault, Privy — is an
operational dependency: an account, a key policy, an IAM boundary, a break-glass
procedure and someone who owns all four. The project does not take that on before
there is anything to protect.

What makes the delay affordable is that **none of the controls bounding a stolen
verifier key depend on where the key is stored.** They are all on the chain:

| Control | Where |
|---|---|
| The key must be in the approved allowlist | `VerifierKey` PDA, admin-only |
| The registration expires | `VerifierKey.expires_at`, program-enforced |
| A judgement is **proposed**, waits `SLASH_DELAY_SECONDS` (72h), and is re-checked before it pays | `propose_slash` → `execute_slash`, settlement program |
| Revoking the key voids every judgement it signed that is still in flight | `execute_slash` re-asks `assert_can_sign`; `expire_slash` releases the reservations |
| At most `slash_cap_bps` of a provider's stake per rolling 24h (deployment default 10%, program ceiling 50%); repeated windows can compound | `slash_cap_bps` bounded by `MAX_SLASH_CAP_BPS`, settlement program |
| A per-key daily ceiling on top of the per-provider one | `Config.verifier_daily_cap`, settlement program |
| The admin key that enrols verifiers is not in this codebase | operator tooling |
| The admin key is also the only one that can cancel a pending judgement | `cancel_slash` — this backend BUILDS it and cannot sign it |

The third and fourth rows are the important ones. A one-step slash that proved a
signature and moved money in one instruction would make a leaked key worth a
provider's stake at the speed of one block. With the two-phase design the
signature buys a *reservation* and nothing else — `propose_slash` has no token
account in its accounts struct at all — and the money does not move until
`execute_slash` asks the allowlist a second time, 72 hours later. One
`revoke_verifier` transaction inside that window voids everything the key
signed, and `expire_slash` (permissionless) releases the stake it reserved.

That is what makes an environment variable an acceptable place for the key
today: stealing it buys 72 hours of visible, cancellable proposals rather than a
transfer.

### The rules this buys

1. **Never call a signing primitive directly.** Go through the port —
   `SignerPort` (`src/modules/verification/signing/ports/signer.port.ts`) for the
   verifier key, `FeePayerSignerPort` for the facilitator's. A call site that
   imports `crypto` and signs is a call site that has to be rewritten for KMS.
2. **No port may return private key material.** Not `exportKey`, not
   `getSecret`, not a `privateKey` field. A remote signer *cannot* implement it,
   so adding one turns the swap into a rewrite. Asserted, not documented —
   `signer-port.contract.ts`, run against every backend.
3. **Every operation is `async`,** including "get the public key". A remote
   signer's operations are network calls.
4. **A backend enum member with no implementation must fail the boot,** with a
   list of what does work. Never resolve to `undefined` and fail at the first
   signature.
5. **The env backend deletes its variable from `process.env` after reading it**
   and imports the key as a **non-extractable `CryptoKey`**. Both are cheap and
   both are what make "the material does not escape" true of code nobody has
   written yet. See `backends/env-key-source.ts`.
6. **No error message may quote the value it failed to parse.** `JSON.parse` on
   Node puts the offending input in its message; re-raising that on malformed
   key material prints the key into the boot log.

### The seam is proven, not promised

`test/unit/verification/signing/signer-port.contract.ts` is a suite every
`SignerPort` implementation must pass, and **two implementations run it**:
`EnvKeypairSigner` and `AwsKmsSigner`. A seam with one implementation is untested
by construction — the first real backend is where you find out which of the
port's guarantees were accidents of the first one. Adding a backend means running
that suite against it; a backend that cannot pass it would have broken a call
site.

`AwsKmsSigner` is written, tested and **not selectable yet**: its client is
deliberately unbound, because adding a cloud SDK to the dependency tree for a
path nothing calls is weight that never comes back off. Selecting `kms` fails the
boot naming the three things missing — `yarn add @aws-sdk/client-kms`, a
`KmsSigningClient` adapter for `KMS_SIGNING_CLIENT`, and `VERIFIER_KMS_KEYS`.
That is the true size of the swap; it is not one line.

One fact worth keeping: Solana verifies **Ed25519**, and AWS KMS could not produce
an Ed25519 signature until November 2025. The key spec is `ECC_NIST_EDWARDS25519`
and the signing algorithm must be `ED25519_SHA_512` over `MessageType: RAW` —
`ED25519_PH_SHA_512` over a `DIGEST` is Ed25519**ph**, a different scheme that the
on-chain sig-verify instruction rejects. Both are enforced in `aws-kms.signer.ts`.

### Where the keys are

| Key | Variable | Backend seam |
|---|---|---|
| Buyer's own escrow key | **not in this codebase, ever** | none — every buyer-signed instruction (`open_escrow`'s implicit identity, `redeem_voucher`'s proof, `set_escrow_limits`, `request_withdraw`, `withdraw`) is built unsigned by `SolanaEscrowIntentBuilder` with `compileTransaction` over a `createNoopSigner` and handed back for the buyer's own wallet to sign |
| Verifier signer | `VERIFIER_SIGNING_KEYS` | `SignerPort` (`env` \| `kms` \| `turnkey` \| `vault` \| `privy`) |
| Facilitator fee payer — **also the settlement program's redeemer** | `LOCAL_FEE_PAYER_KEYPAIR` / `LOCAL_FEE_PAYER_KEYPAIR_PATH`, or Kora | `FeePayerSignerPort` |
| Settlement program admin | **not in this codebase** | operator keypair file |
| Platform treasury (intended to be a multisig on Solana; a single-signer account in the EVM testnet design) | **not in this codebase** | none — the compensating `deposit_stake` is built unsigned by `SolanaStakeIntentBuilder` and signed by the treasury's own signers; `POST /operator/cases/:id/compensated` verifies the landed transaction against the cluster before the case records anything |

The buyer row is a different kind of "not in this codebase" from the admin row: the
admin key is absent by policy — it could technically live here and the design says
it must not. The buyer's key is absent *structurally* — there is no code path
anywhere in this backend that could hold it even by mistake, because every
instruction a buyer signs is compiled over a `createNoopSigner` and the port that
returns it has no `send`, no `submit`, no `signature` and no signer parameter (the
same shape `SolanaStakeIntentBuilder` uses for provider stake). This backend can
build the exact bytes a `redeem_voucher` needs signed, and cannot itself produce a
signature over them.

The fee payer has a second job. `redeem_voucher.rent_payer` carries
`address = config.redeemer`, so the key that pays for a redemption is the only
key the program will accept one from — redemption is not permissionless,
because a buyer who could land a self-signed dust voucher at seq N+1 before the
cron landed seq N would void N for ever at the platform's cost. There is no extra
key: `Config.redeemer` must be set to whatever `FeePayerSignerPort` resolves to,
with `yarn devnet:init-config --redeemer <pubkey>` at deployment and
`update_config` afterwards. `SolanaVoucherRedeemer` checks the two agree on its
first redemption and answers `CHAIN_REDEEMER_MISMATCH` plus a CRITICAL alert
rather than letting every hold burn a preflight against `NotRedeemer` (6053) once
a minute.

The admin row is the one that matters most among the rest and is easiest to miss.
The admin key decides *which* signing keys the program accepts, so it must not
live where a signing key lives — if one process held both, compromising it would
be enough to mint a verifier and slash every provider. Enrolment is
`yarn verifier:registry`, run by a human.

The admin key also cancels: `cancel_slash` is admin-signed, so withdrawing a
standing judgement is a human act. `SlashExecutorPort.buildCancel` compiles the
transaction with an empty signature slot, `POST /operator/cases/:id/cancel-intent`
hands it over, and `SlashLifecycleJob`'s admin-cancel sweep mirrors `CANCELLED`
when it lands — or calls the permissionless `expire_slash` seven days later if
nobody signs it, so a provider's capital is released without a human in the worst
case. An overturned executed judgement is compensated by the treasury, in the row
above.

### Before mainnet

Bind a real KMS client and flip `VERIFIER_SIGNER_BACKEND`, do the same for the
payout authority, and split the verifier signer into its own `SERVICE_TYPE` as
the facilitator already is. **No call site changes** — that is the point of
writing them against a port today.

## Testing

- Unit tests in `test/unit/` (`yarn test` and `yarn test:unit` both run these). They need no
  database, Redis or network.
- Integration tests in `test/integration/` (`yarn test:integration`) run against a real
  PostgreSQL and Redis — see `CONTRIBUTING.md`.
- Jest config: `test/jest-unit.json` (unit), `test/jest-integration.json` (integration),
  `test/jest-e2e.json` (e2e).

## Bootstrap Registration

When adding a new feature module to the API service, import its `*-api.module.ts` in
`src/bootstrap/api/app.module.ts` under the "Domain Modules" section. If the feature
has background work, import its `*-worker.module.ts` in
`src/bootstrap/worker/app.module.ts` as well — never the api variant.

Env-gated module imports must be written INLINE in the `imports` array after
`ConfigModule.forRoot(...)`. `process.env` reads from top-of-file constants resolve
before `.env` is loaded, which silently disables the module.
