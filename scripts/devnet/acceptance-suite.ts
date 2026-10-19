/**
 * `yarn devnet:acceptance` — the devnet acceptance suite orchestrator.
 *
 * The MAIN file of an end-to-end acceptance run against a real
 * devnet-connected API server and the real devnet chain — provider onboarding,
 * tool binding, buyer payment, verification and settlement. Solana has no
 * slash path (no case opens on it; the on-chain dispute and arbiter are EVM's),
 * so the run ends at step 7. Built on the reusable helpers under `scripts/devnet/lib/`
 * (`acceptance-identity.ts`, `acceptance-keys.ts`, `acceptance-http.ts`,
 * `acceptance-report.ts`).
 *
 * ## Sharp edges
 *
 * - **Two Nest contexts, two lifetimes.** `bootIdentityContext()` boots a
 *   minimal `DatabaseModule`-only context used ONLY to mint org/agent/
 *   bearer-credential rows directly into this deployment's real Postgres — see
 *   `lib/acceptance-identity.ts`. Every suite step talks to the live API
 *   server over plain HTTP via `createApiClient()`, never through that
 *   context, and it is closed as soon as the run ends.
 * - **The provider is a person, not a minted agent.** Provider writes are
 *   behind `HumanSessionGuard`, so the provider's token is
 *   `ACCEPTANCE_PROVIDER_PERSON_TOKEN`: a `"kind": "human"` record of the API
 *   server's `MCP_CREDENTIALS_FILE` (`AUTH_SESSION_SOURCE=both`), naming an
 *   organization that is not a provider yet — a fresh record per full run.
 *   The buyer is still minted. See `adoptConfigPersonIdentity`.
 * - **That context is also what loads `.env.local`.** `-r dotenv/config` on
 *   the command line loads `.env` and only `.env`; `.env.local` reaches
 *   `process.env` solely because `@nestjs/config`'s
 *   `assignVariablesToProcess` runs inside `bootIdentityContext()`. Anything
 *   reading `process.env` for a value an operator may override there —
 *   `currentTermsVersions()` below is the current example — MUST run after
 *   that boot. This ordering is load-bearing and invisible. `API_BASE_URL` is
 *   the one thing that cannot obey it (the preflight has to precede the boot),
 *   so it is documented as `.env`/shell-only where it is declared.
 * - **A challenge message is signed VERBATIM.** The `message` string a
 *   `/challenge` endpoint returns is the exact byte sequence the backend
 *   re-derives and verifies against (`buildStakeAuthorityMessage` in
 *   `src/modules/chains/solana/solana-chain.adapter.ts`). Rebuilding it
 *   locally instead of signing the server's own copy was a real defect in the
 *   analogous payout-proof flow. Never do it.
 * - **Sign with `@solana/kit`'s own `signBytes`.** A `KeyPairSigner` carries a
 *   Web Crypto `CryptoKeyPair` at `.keyPair`; `signBytes(key, data)`
 *   (re-exported from `@solana/kit`, backed by `@solana/keys`) signs arbitrary
 *   bytes with `.keyPair.privateKey` via `crypto.subtle.sign`, and
 *   `getBase58Decoder().decode(...)` produces the base58 string the backend
 *   expects — confirmed against `verifySignature` in
 *   `solana-chain.adapter.ts`, which base58-decodes `signature` before
 *   `node:crypto`'s `verify`. `tweetnacl`/`bs58` are not dependencies of this
 *   project and are not needed.
 * - **The backend builds transactions and never sends them.** Every stake
 *   intent comes back with all its signature slots empty (`createNoopSigner` +
 *   `compileTransaction`), and there is **no endpoint that accepts a signed
 *   one** — three separate source comments say so, and
 *   `SolanaStakeIntentBuilder` declares an RPC client with no `sendTransaction`
 *   on it so that none can be reached for. The script signs and broadcasts,
 *   the way `setup-stake-accounts.ts` does. Do not add a submit route to make a
 *   later step easier.
 * - **Open the stake account before depositing into it.** `open_stake` is
 *   deliberately not `init_if_needed` and `deposit_stake` requires an existing
 *   account; the backend refuses the wrong order with
 *   `PROVIDER_STAKE_ACCOUNT_NOT_OPEN` / `..._ALREADY_OPEN`, and refuses both
 *   before a proved `stake_authority` exists.
 * - **`hasEnoughStakeAsset` is not a general precondition.** It is `false`
 *   whenever `stakeAssetBalance` is `null`, and null means "no token account",
 *   not zero — so it is false for a provider who has never held the stake mint
 *   *even when the requirement is `0`*, which is every `OPEN_STAKE`. Read
 *   `hasEnoughGas` always, `hasEnoughStakeAsset` only when
 *   `requiredStakeAsset.amount !== '0'`. See `assertStakeIntent`.
 * - **A confirmed on-chain write is not immediately visible to the gate that
 *   reads it.** `OnChainProviderStakeSource` reads at `confirmed` through a
 *   load-balanced RPC pool and *deletes* a cached reading whenever a read finds
 *   no account — so a pool member a few slots behind can evict a correct
 *   reading with a truthful "not yet". Anything asserting on a state this suite
 *   just put on chain has to converge rather than read once. See
 *   `awaitStakeVisibleToGate`, which was written after that race failed a live
 *   run.
 * - **A running SCHEDULER is a prerequisite of this suite, and it makes step 5
 *   take minutes.** This is the one prerequisite that is not the API server,
 *   and it is easy to miss because `runPreflight` cannot check it: the
 *   scheduler serves no HTTP. A settled deposit is credited `DEPOSIT_PENDING`,
 *   which moves `pending` and **not `available`** — and `available` is the only
 *   bucket a hold can be taken against, so nothing downstream of step 5 can
 *   spend a deposit until `DEPOSIT_CONFIRM` is written. The only thing in
 *   `src/` that writes one is `DepositFinalityService.promotePendingDeposits`,
 *   reached only from `DepositFinalityJob`'s `@Cron(DEPOSIT_FINALITY_SWEEP_CRON)`
 *   in `PaymentSchedulerModule`, which only the scheduler process imports.
 *   There is no route, no queue message and no script that triggers it.
 *   `SERVICE_TYPE=all` boots the scheduler beside the API and is what the local
 *   devnet stack normally runs; `SERVICE_TYPE=api` alone leaves step 5 waiting
 *   for something that will never happen, and the timeout says so by name.
 *   The cron is wall-clock aligned at five-minute boundaries, so the wait is
 *   uniform over `0…5 minutes` regardless of when the deposit landed —
 *   measured across two live runs, `DEPOSIT_PENDING` at `18:33:16` and
 *   `18:34:55` were **both** promoted at `18:35:01`. That is a real property of
 *   the platform, not latency to be tuned away, and a short timeout here would
 *   only convert a prerequisite into a flake.
 * - **Every HTTP path carries the full `/api/v1` prefix.** `main.ts` sets
 *   `app.setGlobalPrefix('api')` plus URI versioning, so there are no bare
 *   `/providers` routes to call.
 * - **The MCP server is a different process on a different port, speaking a
 *   different protocol.** `SERVICE_TYPE=all` boots six listeners; the API is
 *   `3000`, the *facilitator* is `3100`, and MCP is `3200` (`app.mcp.port`,
 *   `MCP_PORT`). Steps 6 and 7 are the only ones that leave the REST surface,
 *   and they speak JSON-RPC over Streamable HTTP through the reference SDK
 *   client — never `fetch` — because the SDK validates every frame against the
 *   specification's schemas and **discards what it does not recognise**. A
 *   catalogue driven by `curl` can therefore show a price no real agent would
 *   ever receive, which is the one thing `tools/list` exists to publish.
 * - **The price is published TWICE and only one copy survives an SDK client.**
 *   The server puts `x402/price` in `annotations`, but the
 *   specification types `annotations` as a closed set of behavioural hints and
 *   the SDK's zod schema strips every key it does not know. `_meta` is specified
 *   as an open record and survives, so it is the copy `listTools()` actually
 *   returns — `DUPLICATED_INTO_META` in `mcp.constants.ts` is the contract. Step
 *   6 reads `_meta`, and reports which channel carried the price so a future
 *   change in either direction is visible in the report rather than silent.
 * - **A tool is shared supply, so the price an agent is quoted is not
 *   necessarily this run's binding.** `ProviderRouterService.quote` returns the
 *   **dearest eligible** binding across every provider behind the tool, and
 *   `route` then picks weighted-randomly among them. Every completed run of this
 *   suite leaves one more `ACTIVE` binding on the same catalogue tool, so by
 *   design the quote is a maximum over N bindings and this run's own serves
 *   roughly one call in N. Step 7 therefore asserts the platform's actual
 *   promise — *charged exactly what `tools/list` quoted, never more* — and
 *   **reports** rather than asserts which provider served. See {@link runStep7}.
 * - **A step's only job is to succeed or throw.** `step()` owns BOTH report
 *   records: the `OK` one built from the detail string a step returns, and the
 *   `FAILED` one built from anything it throws (rethrown, so the run still
 *   fails fast). A step therefore never calls `report.record()`
 *   and never catches its own errors — a step that did could produce a green
 *   run with a silent report, which is the failure this seam exists to make
 *   impossible.
 * - **The report is written in a `finally`**, so a run that fails anywhere
 *   after `main()` starts still leaves evidence on disk.
 */
// `.env` is loaded by `-r dotenv/config` in the `devnet:acceptance` script
// entry (package.json) — **before** this file or any of its imports run. See
// `deposit.ts` for why loading it here instead would be too late for any
// module-load-time `process.env` read elsewhere in the graph.

import { randomBytes, randomInt } from 'node:crypto';

import type { INestApplicationContext } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  address,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  signBytes,
  signTransaction,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import type { DataSource } from 'typeorm';

import type {
  CreateAgentCredentialBodyDto,
  CreateAgentCredentialResponseDto,
} from '@modules/account/dto/create-agent-credential.dto';
import type { AgentCredentialDto } from '@modules/account/dto/list-agent-credentials.dto';
import { X402_VERSION } from '@modules/chains/facilitator/facilitator.wire';
import {
  type AccountId,
  type AssetId,
  CHAIN_IDS,
  type ChainId,
  isAssetId,
  toAccountId,
  toAssetId,
} from '@modules/chains/ports/caip.types';
import type { Money } from '@modules/chains/ports/money.types';
import { SOLANA_PAYMENT_SCHEME } from '@modules/chains/solana/solana.constants';
import type {
  AccountBalanceDto,
  GetBalancesResponseDto,
  MoneyDto,
} from '@modules/ledger/dto/get-balances.dto';
import { X402_PRICE, X402_RECEIPT, X402_TOOL_ID } from '@modules/mcp/constants/mcp.constants';
// The credential file's own loader, rather than a second `JSON.parse` of the
// same path: it is what the running API parses the file with, so this script
// cannot come to disagree with the server about what the file means.
import {
  DEPOSIT_FINALITY_SWEEP_CRON,
  DEPOSIT_INTENT_TTL_MS,
} from '@modules/payment/constants/deposit-intent.constants';
import type {
  CreateDepositBodyDto,
  CreateDepositResponseDto,
  SettleDepositBodyDto,
  SettledDepositDto,
  SolanaDepositRequirementsDto,
} from '@modules/payment/dto/create-deposit.dto';
import { DepositIntentStatus } from '@modules/payment/ports/deposit.types';
import { isTerminalPaymentIntentStatus } from '@modules/payment/domain/payment-intent-transitions';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';
import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import type {
  CheckConnectivityResponseDto,
  DeclareEndpointBodyDto,
} from '@modules/provider/dto/check-connectivity.dto';
import type { SolanaUnsignedTransactionDto } from '@modules/chains/dto/unsigned-chain-transaction.dto';
import type {
  CreateStakeIntentBodyDto,
  CreateStakeIntentResponseDto,
} from '@modules/provider/dto/create-stake-intent.dto';
import {
  type GetProviderRegistrationResponseDto,
  ProviderOnboardingStepKey,
} from '@modules/provider/dto/get-provider-registration.dto';
import type {
  GetProviderStakeResponseDto,
  ProviderChainStakeDto,
} from '@modules/provider/dto/get-provider-stake.dto';
import type { ToolCatalogueDto } from '@modules/provider/dto/get-tool-catalogue.dto';
import type {
  CreatePayoutChallengeResponseDto,
  ProvePayoutAddressResponseDto,
} from '@modules/provider/dto/prove-payout-address.dto';
import type {
  CreateStakeAuthorityChallengeResponseDto,
  ProveStakeAuthorityResponseDto,
} from '@modules/provider/dto/prove-stake-authority.dto';
import type {
  PublishCheckDto,
  PublishedToolBindingDto,
} from '@modules/provider/dto/publish-tool-binding.dto';
import type {
  RegisterProviderBodyDto,
  RegisterProviderResponseDto,
} from '@modules/provider/dto/register-provider.dto';
import type {
  SaveToolBindingBodyDto,
  SavedToolBindingDto,
} from '@modules/provider/dto/save-tool-binding.dto';
import type {
  BindingTestReportDto,
  RunBindingTestBodyDto,
} from '@modules/provider/dto/test-tool-binding.dto';
import { BindingTestOutcome } from '@modules/provider/ports/binding-test.types';
import {
  ConnectivityOutcome,
  OnboardingStepStatus,
} from '@modules/provider/ports/provider-registration.types';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { ProviderStatus } from '@modules/provider/ports/provider.types';
import { StakeIntentKind } from '@modules/provider/ports/stake-intent-builder.port';
import { ResponseClass } from '@modules/tool/domain/classification';
import type { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { minimumStakeFor } from '@modules/tool/domain/routing/stake-gate';
import { BindingAuthMode, BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
import {
  StageStatus,
  UNSAMPLED_STAGES,
  VERIFICATION_PIPELINE,
  VerificationStage,
} from '@modules/verification/domain/stage';
import { VerdictStatus } from '@modules/verification/domain/verdict';
import type {
  GetReceiptResponseDto,
  ReceiptStageDto,
} from '@modules/verification/dto/get-receipt.dto';
import { MoneyUtil } from '@shared/utils/money.util';

import { explainProgramError, type Sender } from '../settlement/lib/sender';
import { AcceptanceHttpError, createApiClient } from './lib/acceptance-http';
import {
  adoptConfigPersonIdentity,
  bootIdentityContext,
  borrowOrganizationCredential,
  mintScriptIdentity,
} from './lib/acceptance-identity';
import { bootSender, generateFundedSigner } from './lib/acceptance-keys';
import { AcceptanceReport } from './lib/acceptance-report';
import { buildDepositPayload } from './lib/build-deposit-payload';
import { DEVNET_TOKEN_DECIMALS } from './lib/token-decimals';

/**
 * Where the live devnet API server is, defaulting to where it usually is.
 *
 * Set it in `.env` or the shell environment — **`.env.local` is loaded too
 * late for this one**. This is the single value in the file that the header's
 * `.env.local` rule cannot cover: it is read at module load, and `.env.local`
 * only reaches `process.env` when `bootIdentityContext()` runs, which is
 * necessarily *after* the preflight that uses this. The failure is silent —
 * if anything at all is listening on the default port, the preflight passes
 * and the whole suite runs green against a server nobody meant to test.
 */
const API_BASE_URL = process.env.ACCEPTANCE_API_BASE_URL ?? 'http://127.0.0.1:3000';

/**
 * The devnet CAIP-2 id, imported and never re-typed as a literal: a rotation
 * of that string in `caip.types.ts` would otherwise leave this script naming a
 * chain the backend no longer knows, and the failure would surface as a
 * confusing per-request rejection rather than as a compile-time break.
 */
const SOLANA_DEVNET = CHAIN_IDS.SOLANA_DEVNET;

/** One name per step, passed to `step()`, which is the only thing that records it. */
const STEP_0 = '0 — preflight';
const STEP_0B = '0b — stake source preflight';
const STEP_1 = '1 — provider register + stake authority';
const STEP_2 = '2 — endpoint declare + connectivity';
const STEP_3 = '3 — tool binding + mapping tester';
const STEP_4 = '4 — stake + publish';
const STEP_5 = '5 — buyer deposit';
const STEP_6 = '6 — buyer mints an MCP credential, tools/list quotes a price';
const STEP_7 = '7 — a real paid MCP call';

/**
 * Where the live MCP server is — a **different process on a different port**
 * from the API, and neither of the two ports next to it.
 *
 * `SERVICE_TYPE=all` boots six listeners. `3000` is the API every other step
 * talks to, `3100` is the *facilitator* (which step 5 depends on and never
 * addresses directly), and `3200` is MCP — `app.mcp.port` in `app.config.ts`,
 * whose own default is `MCP_PORT || 3200`. That default is mirrored here rather
 * than imported for the same reason `currentTermsVersions` mirrors its env vars:
 * `app.config.ts` reads `process.env` inside a factory Nest calls, and this
 * script has no `ConfigService` to call it with.
 *
 * **Read inside the step, never at module load** — see the file header's
 * `.env.local` note. `ACCEPTANCE_MCP_URL` overrides the whole URL for a
 * deployment where MCP is not on localhost at all; `MCP_PORT` alone is enough
 * when only the port moved.
 */
function mcpUrl(): string {
  return process.env.ACCEPTANCE_MCP_URL ?? `http://127.0.0.1:${process.env.MCP_PORT ?? '3200'}/`;
}

/** How this run identifies itself in `initialize`. Cosmetic; it reaches the server's logs. */
const MCP_CLIENT_NAME = 'devnet-acceptance-suite';
const MCP_CLIENT_VERSION = '0.1.0';

/**
 * An organization whose provider is staked **on the chain** — the witness
 * {@link assertStakeSourceIsChain} questions.
 *
 * It has to be both things at once, and each one is doing work:
 *
 * - **Staked on chain**, so that a chain-backed source has something to
 *   report: the organization's `ProviderStake` PDA must already hold a
 *   non-zero `bonded` balance, put there by a provider-stake run beforehand.
 * - **Has a proved `stake_authority`**, or the chain source has no account to
 *   read for it.
 *
 * `a965eec3` looks like an alternative. It does not work and cannot be
 * made to: it has a `providers` row and an on-chain stake, but **no
 * `organizations` row and no agent**, so no session can ever be minted for it.
 *
 * Override with `ACCEPTANCE_STAKED_PROVIDER_ORG_ID` on a deployment where this
 * id does not exist. Read inside the function, not here: see the header's
 * `.env.local` note.
 */
const CHAIN_STAKED_WITNESS_ORG_ID = '677e6a64-e7b6-401b-8387-aacf0f2ff1a7';

/**
 * Whole tokens of the devnet USDC standin the provider's keypair is funded
 * with, before it stakes any of them.
 *
 * `100`, against a requirement that {@link randomBindingPriceMinor} can push
 * as high as `$90` — so the highest draw still leaves headroom rather than
 * turning an unlucky price into a failed run. Steps 1–3 spend none of it
 * (step 1 is a signature, step 2 an HTTP probe, step 3 a tester run that
 * `runStep3` proves costs nobody anything); every token of it is here for
 * step 4's `deposit_stake`.
 *
 * Not the same budget as gas: `generateFundedSigner` also sends `0.05 SOL`,
 * which is what pays for rent on the `ProviderStake` account and the two
 * signatures. Staking is deliberately **not** sponsored, and
 * `GAS_NOT_SPONSORED_REASON` says it on the wire.
 */
const PROVIDER_USDC_FUNDING_TOKENS = 100;

/**
 * Whole tokens of the devnet USDC standin the **buyer's** keypair is funded
 * with, before it deposits any of them.
 *
 * Twice {@link BUYER_DEPOSIT_AMOUNT_MINOR} on purpose, and the surplus is doing
 * work: the wallet is left visibly holding the difference, so a transfer that
 * moved the wrong amount (the whole balance, a re-scaled figure) cannot be
 * mistaken for a correct one that happened to drain it. `generateFundedSigner`
 * also sends `0.05 SOL`, none of which this step spends — the deposit is
 * gasless by construction, and a wallet holding no SOL is the case the
 * facilitator's fee-payer slot exists for.
 */
const BUYER_USDC_FUNDING_TOKENS = 50;

/**
 * What step 5 deposits, in **minor units** — the wire's own unit everywhere in
 * this system (`chains/ports/money.types.ts`: money is never a `number`).
 *
 * `25.123456`, not a round `25.000000`, and the digits are the reason: every
 * decimal place is distinct and non-zero, so a truncation, a re-scaling, a
 * swapped operand or a decimal round trip through a float shows up as an
 * obviously wrong figure rather than as a plausible one. `$8.29` is where a
 * float conversion was once observed silently losing money on this exact path;
 * nothing here converts a decimal (the string goes out and comes back), and a
 * value like this is what would notice if something downstream started to.
 *
 * ## What actually draws it down, which is less than it looks
 *
 * **Step 7's single paid call, at up to `$0.09`. That is all.** So this is
 * deliberately over-sized by two orders of magnitude, and that is fine: the
 * tokens are a devnet standin this run mints for itself.
 */
const BUYER_DEPOSIT_AMOUNT_MINOR = '25123456';

/**
 * How long a devnet blockhash stays sendable — **measured, not the number the
 * tooling assumes**, and the real constraint on step 5.
 *
 * A blockhash is valid for 150 blocks. At the 400 ms slot time everyone quotes
 * that would be 60 seconds; devnet actually produces a block every ~211 ms, so
 * it is about **31**. That is less than half of `DEPOSIT_INTENT_TTL_MS` (90 s),
 * which is why an intent can be comfortably alive while the transaction it
 * holds has stopped being acceptable — and why the fix is never a longer TTL.
 * Measured at both ends: a 34-second create→settle failed with
 * `BlockhashNotFound`, an 8.1-second one settled.
 *
 * Used only to *report*, never to gate: a run that crosses it should fail with
 * the chain's own refusal and this figure beside it, not be refused locally on
 * an estimate of when the chain would have refused it.
 */
const BLOCKHASH_WINDOW_MS = 31_000;

/**
 * How long step 5 will wait for its deposit to become **spendable**, and why
 * the number is minutes rather than seconds.
 *
 * A settled deposit is credited as `DEPOSIT_PENDING`, whose effect is
 * `{ available: 0, held: 0, pending: 1 }` — it moves `pending` and **nothing
 * else**. The only entry type that credits `available` is `DEPOSIT_CONFIRM`
 * (`ledger-entry-effect.ts`), and the only thing in `src/` that writes one is
 * `DepositFinalityService.promotePendingDeposits`, whose only production caller
 * is `DepositFinalityJob`'s `@Cron(DEPOSIT_FINALITY_SWEEP_CRON)`. There is no
 * HTTP route, no queue message and no script that triggers it — checked.
 *
 * That cron is `EVERY_5_MINUTES`, which is the wall-clock-aligned `0 * / 5 * * * *`
 * (spaced here so this comment is not a comment terminator), so a deposit waits
 * until the next five-minute boundary no matter how long ago it landed.
 * Measured across two live runs: `DEPOSIT_PENDING` at 18:33:16
 * and 18:34:55, **both** promoted at 18:35:01 — 105 s and 6 s respectively,
 * because the boundary, not the deposit, decides. So the wait is uniform over
 * `0…300s` and averages 150.
 *
 * Hence 360 s: one whole cron period plus a minute for the sweep's own
 * `finalized` chain read. Shortening it would not make the suite faster, it
 * would make it flaky — the wait is a real property of the platform, not
 * latency to be tuned away.
 */
const DEPOSIT_CREDIT_TIMEOUT_MS = 360_000;

/** Gap between `GET /balances` reads while waiting for that promotion. */
const DEPOSIT_CREDIT_POLL_MS = 5_000;

/**
 * The scale `loadMinimumStakeParameters` quotes the stake floor in, mirrored
 * as the literal `6` it is in `provider-stake.service.ts`.
 *
 * Deliberately not `binding.price.decimals`. The server builds **both**
 * operands of `minimumStakeFor` at `parameters.floor.decimals` — the price
 * included, `evaluateStakeGate` does `MoneyUtil.of(binding.priceAmount,
 * binding.assetId, parameters.floor.decimals)` — so mirroring the literal is
 * what reproduces the server's arithmetic. Taking the scale off the response
 * instead would agree with it on this deployment and diverge silently on one
 * where they differ, which is the wrong way round: `MoneyUtil` refuses two
 * operands of the same asset at different scales, so a real divergence should
 * fail loudly here rather than compute a second answer.
 */
const STAKE_FLOOR_DECIMALS = 6;

/**
 * The upstream this run declares as the acceptance provider's endpoint.
 *
 * A **real** third-party API, deliberately not one this suite owns: the point
 * of the connectivity check is that the platform's own egress can reach the provider, and an
 * endpoint served by this process would prove nothing about that path. It is
 * also not a throwaway "something that returns 200" — it is the base URL the
 * seeded demo catalogue already binds its `get_usd_eur_rate` tool to
 * (`scripts/mcp/seed/catalogue.json`, `scripts/demo/seed-provider-console.ts`
 * `label: 'fx'`), so the later tasks that bind a tool and run the mapping
 * tester against a live upstream have a request/response mapping already known
 * to work against it: `GET /v1/latest?base=USD&symbols=EUR` →
 * `{ rate: $.rates.EUR, publishedFor: $.date }`.
 *
 * Chosen over the catalogue's other known-good pair, `api.open-meteo.com` /
 * `get_weather`, for a reason that only bites later: that mapping projects
 * `observedAt` from an **offset-less** timestamp, and `FRESHNESS` parses such a
 * value as local time — so on any non-UTC host it strikes an honest provider by
 * the host's offset (a known timestamp-timezone defect). Frankfurter's `$.date`
 * is a plain calendar date with no clock in it, so it does not walk into that
 * open defect.
 */
const PROVIDER_ENDPOINT = 'https://api.frankfurter.dev';

/**
 * The seeded catalogue tool this run implements, and the mapping that is
 * already known to work against {@link PROVIDER_ENDPOINT}.
 *
 * The id and both mappings are the seed's own, copied from
 * `scripts/mcp/seed/catalogue.json` and `scripts/demo/seed-provider-console.ts`
 * (`label: 'fx'`), which agree with each other field for field. They are
 * duplicated here rather than read out of the seed file because the file seeds
 * a *different* provider's binding — this run authors its own, under its own
 * fresh organization, and the only thing being borrowed is the knowledge that
 * this request/response pair answers correctly against this endpoint.
 *
 * The tool takes no arguments (`inputSchema.properties` is empty), which is why
 * the tester below is called with `{}` rather than a sample document.
 */
const ACCEPTANCE_TOOL_ID = 'a4b9882a-9bc1-4d64-807a-27c0b93daf0a';
const ACCEPTANCE_REQUEST_MAPPING = {
  method: 'GET',
  path: '/v1/latest',
  query: { base: 'USD', symbols: 'EUR' },
};
const ACCEPTANCE_RESPONSE_MAPPING = {
  rate: { $path: '$.rates.EUR' },
  publishedFor: { $path: '$.date' },
};

/**
 * Context threaded through every suite step.
 *
 * `api` lives on the actor, not at the top level, and `buyer` is why: the two
 * actors are separate organizations with separate bearer tokens, so a single
 * shared client could only ever hold one of the two. The shape was declared
 * before the buyer existed and is now filled in rather than revised.
 *
 * `binding` is how a step hands a later step something it made. `step()`
 * deliberately returns only the detail string it records, so widening that
 * signature to carry a payload would take back the property several review
 * rounds paid for — that a step *cannot* run without being recorded. Mutating
 * the context is the seam for this instead.
 */
interface SuiteContext {
  provider: {
    signer: Awaited<ReturnType<typeof generateFundedSigner>>;
    api: ReturnType<typeof createApiClient>;
    /**
     * This run's provider, by the id the **routing** side of the platform calls
     * it — which is the organization id, not a separate `providers.id`.
     *
     * `DbProviderRegistry` maps `providerId: row.organizationId`
     * (`db-provider-registry.ts`), `BindingPublishService` writes the same value
     * onto every published binding, and `payment_intents.provider_id` therefore
     * holds an organization id. Step 7 needs it to say whether *this run's*
     * provider was the one that served the paid call — which it can only report,
     * never assert; see {@link runStep7}.
     */
    organizationId: string;
  };
  /**
   * The buyer: a second organization, its own bearer token, its own funded
   * devnet keypair.
   *
   * Structurally identical to `provider` and deliberately not merged with it.
   * The two are different tenants — that is the whole point of organization scoping —
   * and every assertion from step 5 onward about money leaving one side and
   * arriving at the other is only evidence because these are two credentials
   * the server cannot tell apart from any other pair.
   *
   * `signer` is **not** the key behind the agent's `primaryAccountId`: that one
   * is a fabricated CAIP-10 the identity mint invents so the session guard
   * passes (`acceptance-identity.ts`). Nothing on the deposit path derives an
   * on-chain account from it — `agentAccount` is a ledger key, and the transfer
   * moves from this signer's associated token account.
   */
  buyer: {
    signer: Awaited<ReturnType<typeof generateFundedSigner>>;
    api: ReturnType<typeof createApiClient>;
    /**
     * The buyer's agent row, which step 6 mints a **second** credential under.
     *
     * `POST /agents/:agentId/credentials` takes it in the path and checks it
     * against the session's own organization, so it cannot be inferred from the
     * token. It is carried here rather than looked up because `mintScriptIdentity`
     * already returned it — a `GET /agents` round trip would be asking the
     * server for something this run wrote itself.
     */
    agentId: string;
    /** The buyer's tenant. */
    organizationId: string;
    /**
     * The buyer's ledger account — `agents.primary_account_id`, which is what
     * their session carries as `agentAccount` and therefore where step 5's
     * deposit landed and step 7's hold was taken.
     */
    agentAccount: AccountId;
  };
  /**
   * The devnet RPC connection, and the one confirmation loop.
   *
   * Top level rather than on an actor, unlike `api`: there is one chain, and
   * both actors send to it. It is here because a step that is handed an
   * unsigned transaction has to broadcast it **itself** — the backend has no
   * endpoint that accepts a signed one and must never grow one (see
   * {@link runStep4}).
   */
  sender: Sender;
  /**
   * The step-3 binding: `DRAFT`, priced, tested green, not yet published.
   *
   * Set by `runStep3` and read by the step that stakes and publishes it. The
   * price is the **server's** echo rather than this script's copy, because the
   * stake that has to clear the gate is computed from what the row actually
   * holds.
   */
  binding?: {
    readonly id: string;
    readonly price: MoneyDto;
  };
  /**
   * What step 6 hands step 7: an MCP-scoped bearer token, and the catalogue's
   * own answer about the tool behind it.
   *
   * `quoted` is deliberately **not** `binding.price`. The two are the same
   * number only when this run's binding happens to be the dearest eligible one
   * on a shared catalogue tool — see {@link runStep6}. Step 7 charges against
   * this, because this is the figure the agent was shown and the figure the
   * hold is taken for.
   */
  mcp?: {
    readonly token: string;
    readonly credentialId: string;
    /** MCP addresses a tool by name; everything else in the platform by uuid. */
    readonly toolName: string;
    readonly quoted: Money;
    /** Which of the two published copies of the price actually arrived. */
    readonly priceChannel: string;
  };
}

/**
 * The step-3 binding's price in minor units, redrawn on every run.
 *
 * The number matters more than it looks. `minimumStakeFor` is `max(floor,
 * priceMultiple × price)` — `$50` and `1000×` on this deployment
 * (`PROVIDER_MINIMUM_STAKE_FLOOR`, `PROVIDER_MINIMUM_STAKE_MULTIPLE`, defaulted
 * in `provider-stake.service.ts`) — so a price at or under `$0.05` leaves the
 * **flat floor** deciding the bar, and the stake step then proves only that
 * `$50 > $0`. Above it, the price-multiple branch is what sets the requirement,
 * which is the branch worth exercising. The earlier manual provider-stake run
 * picked `$0.08` for exactly this reason.
 *
 * Hence `$0.060`–`$0.090`: every draw is above the floor's reach, and the
 * `1000`-minor-unit granularity keeps `1000 × price` a whole number of USDC
 * (`$60`–`$90`) — a requirement the ~100 USDC that run staked can still
 * clear, so a high draw cannot make the stake step unaffordable.
 *
 * Random rather than fixed because a constant price is a constant minimum, and
 * a suite that always asks the same question of the gate stops noticing when
 * the gate stops asking it — a gate that answers a different question from
 * the one being asked.
 */
function randomBindingPriceMinor(): string {
  return String(randomInt(60, 91) * 1_000);
}

/**
 * Mirrors `loadProviderTerms` in `src/modules/provider/services/provider-terms.ts`
 * field-for-field — same env var names, same `'v1.0'` default — so this
 * script's claimed `acceptedTerms` always match what the live server has
 * published, on any machine. `ProviderRegistrationService.buildAcceptedTerms`
 * rejects a `POST /providers` whose claimed versions differ from the published
 * set, and there is no pre-registration endpoint to read them from: `GET
 * /providers/me/registration` 404s before a provider row exists.
 *
 * **Must be called after `bootIdentityContext()`** — see the file header's
 * note on `.env.local`. Reading these before that boot silently yields `.env`
 * values on a machine whose `.env.local` overrides them.
 */
function currentTermsVersions(): {
  providerAgreementVersion: string;
  payoutTermsVersion: string;
  slashPolicyVersion: string;
} {
  return {
    providerAgreementVersion: process.env.PROVIDER_TERMS_AGREEMENT_VERSION ?? 'v1.0',
    payoutTermsVersion: process.env.PROVIDER_TERMS_PAYOUT_VERSION ?? 'v1.0',
    slashPolicyVersion: process.env.PROVIDER_TERMS_SLASH_POLICY_VERSION ?? 'v1.0',
  };
}

/**
 * A wire `MoneyDto`'s asset as the branded `AssetId` the domain functions take.
 *
 * A checked narrowing rather than a cast: `isAssetId` is the registry's own
 * predicate, and every value this is called on came off the wire from a server
 * this script does not control.
 */
function assetIdOf(money: MoneyDto): AssetId {
  if (!isAssetId(money.asset)) {
    throw new Error(`"${money.asset}" is not a CAIP-19 asset id, so no stake floor can be built`);
  }
  return money.asset;
}

/** The same narrowing for a whole amount, so `MoneyUtil` can be given wire values. */
function toMoney(money: MoneyDto): Money {
  return { amount: money.amount, asset: assetIdOf(money), decimals: money.decimals };
}

/**
 * Mirrors `loadMinimumStakeParameters` in
 * `src/modules/provider/services/provider-stake.service.ts` field-for-field —
 * same env var names, same `'50000000'` and `1000` defaults — on the same
 * grounds as {@link currentTermsVersions}: there is no endpoint that reports
 * the floor for a binding that is still `DRAFT`. `GET /providers/me/stake`
 * itemises the requirement over **ACTIVE** `PAID`/`FREEMIUM` bindings only,
 * which is precisely the set this run's binding is not in until step 4 has
 * already succeeded.
 *
 * **Must be called after `bootIdentityContext()`** — see the file header.
 *
 * The `asset` is the binding's own, not `PLATFORM_STAKE_ASSET_ID`. The two
 * have to be the same value or `evaluateStakeGate` never reaches
 * `minimumStakeFor` at all, and step 3 has already proved they are: it asserts
 * `STAKE_AT_MINIMUM` is unmet and records the reason, and the gate checks
 * `binding.assetId !== parameters.floor.asset` **before** it checks for a
 * missing reading — so `STAKE_UNKNOWN` rather than `STAKE_ASSET_MISMATCH` is
 * the server stating that its floor is denominated in this binding's asset.
 * Reading the constant here instead would resolve `SOLANA_DEVNET_USDC_MINT` at
 * module load, which for this script is before `.env.local` exists.
 */
function currentMinimumStakeParameters(asset: AssetId): MinimumStakeParameters {
  return {
    floor: MoneyUtil.of(
      process.env.PROVIDER_MINIMUM_STAKE_FLOOR ?? '50000000',
      asset,
      STAKE_FLOOR_DECIMALS,
    ),
    priceMultiple: Number(process.env.PROVIDER_MINIMUM_STAKE_MULTIPLE ?? 1000),
  };
}

/**
 * What this binding's price obliges its provider to bond, by the **router's
 * own** `minimumStakeFor` — imported, never re-derived.
 *
 * The publish gate does not re-implement the stake rule either; it takes
 * `evaluateStakeGate`'s verdict verbatim (`publish-gate.ts`). Calling the same
 * function here is what makes step 4's deposit the exact number the gate is
 * about to demand, rather than a number that happens to be large enough.
 */
function requiredStakeFor(price: MoneyDto): Money {
  const asset = assetIdOf(price);
  const parameters = currentMinimumStakeParameters(asset);
  return minimumStakeFor(MoneyUtil.of(price.amount, asset, parameters.floor.decimals), parameters);
}

/**
 * Signs a transaction the **backend compiled** and puts it on the chain.
 *
 * ## Why the script broadcasts, and why there is no endpoint for this
 *
 * There is no route that accepts a signed stake transaction, and there must
 * never be one. `StakeIntentBuilderPort` has no send, no submit and no signer
 * parameter; `SolanaStakeIntentBuilder` declares an RPC client with **no
 * `sendTransaction` in it** and compiles with `compileTransaction` rather than
 * `signTransactionMessageWithSigners`, so every signature slot goes out empty.
 * Three source comments say so independently. A provider's stake authority is
 * theirs — `withdraw_stake`'s own comment is *"Only the provider may take their
 * own stake out. The admin key cannot, and neither can the exposure
 * authority."* This function is the provider's wallet, played by a script.
 *
 * ## Why not `sender.send()`
 *
 * `createSender`'s `send` takes **instructions** and builds its own message:
 * its own fee payer, its own blockhash, its own compilation. Handing it the
 * decompiled contents of the backend's transaction would be rebuilding the
 * intent locally — the same class of mistake as rebuilding a challenge string
 * instead of signing the server's own copy, which was a real defect once (see
 * the file header). What is signed here is the byte sequence the backend
 * compiled, unaltered, blockhash included. `sender`'s `rpc` and its one
 * confirmation loop are reused; only the message construction is skipped,
 * because there is nothing to construct.
 *
 * The simulation is `sender.send()`'s, kept for the reason that function keeps
 * it: `explainProgramError` turns a bare `Custom(6008)` into the settlement
 * program's own error name, and a stake instruction failing anonymously is the
 * worst moment for that.
 */
async function signAndBroadcast(
  sender: Sender,
  signer: KeyPairSigner,
  transaction: SolanaUnsignedTransactionDto,
  what: string,
): Promise<string> {
  const compiled = getTransactionDecoder().decode(
    getBase64Encoder().encode(transaction.transactionBase64),
  );
  const signed = await signTransaction([signer.keyPair], compiled);
  const wire = getBase64EncodedWireTransaction(signed);

  const simulation = await sender.rpc
    .simulateTransaction(wire, {
      encoding: 'base64',
      commitment: 'confirmed',
      replaceRecentBlockhash: true,
      sigVerify: false,
    })
    .send();
  if (simulation.value.err) {
    throw new Error(
      `${what} failed in simulation: ${explainProgramError(simulation.value.err)}\n` +
        (simulation.value.logs ?? []).map((line) => `    ${line}`).join('\n'),
    );
  }

  await sender.rpc
    .sendTransaction(wire, { encoding: 'base64', preflightCommitment: 'confirmed' })
    .send();

  const signature = getSignatureFromTransaction(signed);
  await sender.confirm(signature);
  return signature;
}

/**
 * Every assertion the two stake intents share, before a signature is put on
 * anything.
 *
 * ## `hasEnoughStakeAsset` is checked only when the act moves the asset
 *
 * This is the trap on this response, and reading it as a general precondition
 * would break the exact flow it is meant to protect. `hasEnoughStakeAsset` is
 * `false` for a provider who has never held the stake mint — no associated
 * token account means `stakeAssetBalance` is `null`, and null is never read as
 * enough — **even when the requirement is zero**. `OPEN_STAKE` requires zero
 * and touches no token account at all, so a blanket check here would refuse to
 * open a stake account for precisely the provider `open_stake` exists for.
 * `hasEnoughGas` is unconditional; the provider pays their own.
 *
 * The `feePayer`/`signers` check is not ceremony: the backend takes the
 * account from the enrolment's `stake_authority_account_id` and never from the
 * request, so this
 * is the one place a run can confirm that the transaction it is about to sign
 * belongs to the key it holds — and that step 1's proof reached the row the
 * builder read.
 */
function assertStakeIntent(
  intent: CreateStakeIntentResponseDto,
  kind: StakeIntentKind,
  signer: KeyPairSigner,
): SolanaUnsignedTransactionDto {
  if (intent.kind !== kind) {
    throw new Error(`asked for a ${kind} stake intent and got a ${intent.kind} one`);
  }

  const expectedAuthority = toAccountId(SOLANA_DEVNET, signer.address);
  if (intent.account !== expectedAuthority) {
    throw new Error(
      `the ${kind} intent is built for ${intent.account}, not for the key this run holds ` +
        `(${expectedAuthority}) — the enrolment's stake_authority_account_id is not what ` +
        `step 1 proved`,
    );
  }

  if (!intent.transaction) {
    throw new Error(
      `the ${kind} intent came back with no transaction. Only a blocked WITHDRAW is allowed to ` +
        `do that (blockedBy=${intent.blockedBy ?? 'none'})`,
    );
  }
  // `transaction` is the three-member union now. This run signs Solana
  // wire bytes with a Solana keypair, so anything else is a run that cannot
  // continue — and saying so beats reading `undefined` off an eip155 member and
  // comparing it to an address.
  if (intent.transaction.namespace !== 'solana' || intent.transaction.kind !== 'transaction') {
    throw new Error(
      `the ${kind} intent came back as ${intent.transaction.namespace}/${intent.transaction.kind}; ` +
        `this run holds a Solana keypair and can only sign solana/transaction`,
    );
  }
  if (intent.transaction.feePayer !== signer.address) {
    throw new Error(
      `the ${kind} transaction names ${intent.transaction.feePayer} as fee payer, not ` +
        `${signer.address} — staking is not sponsored and the provider pays their own gas`,
    );
  }
  if (intent.transaction.signers.length !== 1 || intent.transaction.signers[0] !== signer.address) {
    throw new Error(
      `the ${kind} transaction wants signatures from [${intent.transaction.signers.join(', ')}] ` +
        `— this run holds exactly one key, ${signer.address}`,
    );
  }

  const { preflight } = intent;
  if (!preflight.hasEnoughGas) {
    throw new Error(
      `not enough SOL for a ${kind}: ${MoneyUtil.format(toMoney(preflight.gasBalance))} held, ` +
        `${MoneyUtil.format(toMoney(preflight.requiredGas))} quoted. ` +
        `${preflight.gasNotSponsoredReason}`,
    );
  }
  // Only when the act actually moves the asset — see the docstring.
  if (preflight.requiredStakeAsset.amount !== '0' && !preflight.hasEnoughStakeAsset) {
    const held = preflight.stakeAssetBalance
      ? MoneyUtil.format(toMoney(preflight.stakeAssetBalance))
      : 'no token account at all';
    throw new Error(
      `not enough stake asset for a ${kind}: ${held} held, ` +
        `${MoneyUtil.format(toMoney(preflight.requiredStakeAsset))} required`,
    );
  }

  return intent.transaction;
}

/** How long step 4 will wait for a confirmed deposit to reach the publish gate. */
const STAKE_VISIBILITY_TIMEOUT_MS = 120_000;
const STAKE_VISIBILITY_POLL_MS = 3_000;

/**
 * How long step 4 will wait for a confirmed `open_stake` to be visible to
 * `POST /deposit-intent`. Shorter than {@link STAKE_VISIBILITY_TIMEOUT_MS}
 * because nothing is cached on this path — see {@link createDepositIntent}.
 */
const STAKE_ACCOUNT_VISIBILITY_TIMEOUT_MS = 30_000;

/** The error code that means "the chain has not shown me your stake account". */
const STAKE_ACCOUNT_NOT_OPEN = ProviderErrorCode.PROVIDER_STAKE_ACCOUNT_NOT_OPEN;

/**
 * The domain code inside an `AcceptanceHttpError`'s body, or `null`.
 *
 * The error envelope is `{ success: false, error: { code, … } }` — see
 * `lib/acceptance-http.ts`, which deliberately does not unwrap it. Reached
 * defensively because a 502 from something in front of the API would put an
 * HTML page or a proxy's own JSON in `body`.
 */
function errorCodeOf(error: unknown): string | null {
  if (!(error instanceof AcceptanceHttpError)) return null;
  const body = error.body as { error?: { code?: unknown } } | null | undefined;
  const code = body?.error?.code;
  return typeof code === 'string' ? code : null;
}

/**
 * `POST /deposit-intent`, retried while the chain still says the stake account
 * is not there.
 *
 * ## Why this endpoint needs it and `open-stake-intent` does not
 *
 * `POST /deposit-intent` is not a pure builder. Before it compiles anything,
 * `ProviderStakeIntentService.assertAccountState` refuses a deposit against an
 * account that does not exist — and "does not exist" comes from `readStake()`
 * → `ONCHAIN_STAKE_READER.bondedStakeOf` → `getMultipleAccounts` at
 * `confirmed`, against the same pooled RPC the file header's lag bullet
 * describes. `guard()` does not retry. So a pool member a few slots behind
 * `open_stake` turns into a hard `409`, **after** the rent and the signature
 * have already been paid.
 *
 * ## Why retrying is not papering over an ordering bug
 *
 * The refusal it raises is `PROVIDER_STAKE_ACCOUNT_NOT_OPEN`, whose message is
 * *"Run POST /providers/me/stake/open-stake-intent and sign it first"* — an
 * ordering mistake this function has provably not made, because it is called
 * with the confirmed signature of exactly that transaction. Left unguarded, the
 * suite's most likely failure would accuse an operator of a bug that the file
 * header and `runStep4`'s docstring both spend paragraphs on, and it would not
 * reproduce when they went looking.
 *
 * Only that one code is retried, and only for
 * {@link STAKE_ACCOUNT_VISIBILITY_TIMEOUT_MS}. A genuine ordering error cannot
 * reach here (the open is awaited and confirmed first), an unproven authority
 * is a different code and still fails on the first attempt, and a `503` from an
 * unreadable chain passes straight through — this waits out lag, it does not
 * wait out an outage.
 *
 * The window is shorter than the publish gate's because there is no cache in
 * the way: `assertAccountState` reads the chain on every call, so each retry is
 * a genuinely new answer. `OnChainProviderStakeSource` can pin a stale reading
 * for 30 seconds, which is why {@link awaitStakeVisibleToGate} waits four times
 * as long.
 */
async function createDepositIntent(
  api: ReturnType<typeof createApiClient>,
  required: Money,
  openSignature: string,
): Promise<CreateStakeIntentResponseDto> {
  const startedAt = Date.now();
  let attempts = 0;

  for (;;) {
    attempts += 1;
    try {
      return await api.post<CreateStakeIntentResponseDto>(
        '/api/v1/providers/me/stake/deposit-intent',
        { amount: required.amount } satisfies CreateStakeIntentBodyDto,
      );
    } catch (error) {
      if (errorCodeOf(error) !== STAKE_ACCOUNT_NOT_OPEN) {
        throw error;
      }
      if (Date.now() - startedAt >= STAKE_ACCOUNT_VISIBILITY_TIMEOUT_MS) {
        throw new Error(
          `open_stake confirmed as ${openSignature}, but ${STAKE_ACCOUNT_NOT_OPEN} is still ` +
            `refusing a deposit after ${attempts} attempt(s) over ${Date.now() - startedAt}ms. ` +
            `This is NOT the ordering mistake that error's message describes — the open was ` +
            `awaited to confirmation before the first attempt. The stake account is not ` +
            `reaching the RPC the API server reads at 'confirmed'. ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, STAKE_VISIBILITY_POLL_MS));
    }
  }
}

/**
 * One chain's entry out of `GET /providers/me/stake`.
 *
 * The response is a **list** — a call settles on one chain and is backed only
 * by that chain's collateral, so there is no provider-wide figure to read and
 * this suite has to name the chain it is asserting about. Every assertion below
 * is about the chain this run staked on, deposited into and published for.
 *
 * A missing entry **throws** rather than answering "no stake". The endpoint
 * reports every chain the provider is enrolled on plus the floor's own, so this
 * run's chain being absent is a defect in the response and not the state a
 * `hasKnownStake: false` describes. Answering the softer thing here would let
 * the suite wait out its whole timeout on a payload that was never going to
 * carry the answer.
 */
function stakeOnChain(
  response: GetProviderStakeResponseDto,
  chainId: ChainId,
): ProviderChainStakeDto {
  const entry = response.stake.find((candidate) => candidate.chainId === chainId);
  if (!entry) {
    throw new Error(
      `GET /providers/me/stake reports no entry for ${chainId} — it carries ` +
        `[${response.stake.map((candidate) => candidate.chainId).join(', ') || 'nothing'}]. ` +
        `The provider is not enrolled on the chain this run is staking on, which is not ` +
        `something waiting fixes.`,
    );
  }
  return entry;
}

/**
 * Waits for the deposit this run just confirmed to be the number the **publish
 * gate** reads, and returns both readings that say so.
 *
 * ## Why this is a poll and not a single read — a race seen live
 *
 * The first live run of this step failed here, and the failure is worth
 * recording because it is not a bug in this script. Both transactions confirmed;
 * `GET /providers/me/stake` reported `staked = 85.000000` and
 * `chainReadable: true`; and the very next call, `publish-check`, answered
 * `STAKE_AT_MINIMUM (STAKE_UNKNOWN: no stake reading for provider …)`. Minutes
 * later, with nothing changed, the same two calls agreed and the binding was
 * publishable.
 *
 * Both go through the same `PROVIDER_STAKE_SOURCE`, so the disagreement is
 * inside it. `OnChainProviderStakeSource` reads the settlement program at
 * **`confirmed`** through a load-balanced RPC pool, caches by stake authority
 * for 30 seconds, and — this is the part that makes a transient miss stick —
 * when a read succeeds and finds *no account* it **deletes** the cached
 * reading, deliberately, so that a provider who closed their stake account
 * cannot stay routable through the next blip. Right after `open_stake`, a pool
 * member a few slots behind answers "no account" truthfully for the slot it is
 * on, and that answer both loses the race and evicts the good one.
 *
 * So "the gate sees the stake" is eventually consistent by construction, on a
 * window measured in slots. Asserting it on the first read asserts something
 * the platform does not promise. What it does promise is that the stake
 * *becomes* visible, and that is what is asserted here — with the wait
 * reported, so a run that had to wait 40 seconds does not look like one that
 * did not.
 *
 * The deadline is what keeps this an assertion rather than a hope: past
 * {@link STAKE_VISIBILITY_TIMEOUT_MS} it throws with the last unmet requirement
 * verbatim — and step 0b has already shown the source reads the chain, so a
 * timeout here means the chain read lagged, not the configuration.
 *
 * Everything that cannot be explained by lag is still fatal on the **first**
 * read: a reading belonging to another authority, a balance in a different
 * asset or at a different scale, or a balance **larger** than this run
 * deposited. What is deliberately *not* fatal is a balance that is merely
 * short, including zero — see the comment on that branch, which is the shape
 * lag actually takes here.
 */
async function awaitStakeVisibleToGate(
  api: ReturnType<typeof createApiClient>,
  bindingId: string,
  required: Money,
  signer: KeyPairSigner,
): Promise<{
  stake: ProviderChainStakeDto & { staked: MoneyDto };
  check: PublishCheckDto;
  attempts: number;
  waitedMs: number;
}> {
  const startedAt = Date.now();
  const expectedAuthority = toAccountId(SOLANA_DEVNET, signer.address);
  let attempts = 0;
  let lastReason = 'no read completed';
  // WHICH branch set `lastReason`, so the timeout can say the true thing.
  // Everything this function knows about stake-source lag is worthless — worse
  // than worthless, it is a wrong lead — once the loop is waiting on a publish
  // requirement that has nothing to do with stake. Not hypothetical: the
  // missing payout-address proof sent an investigation down the stake path
  // while this message insisted the stake was confirmed and the gate could not
  // see it. It was, and it could.
  let lastReasonKind: 'STAKE' | 'GATE' = 'STAKE';

  for (;;) {
    attempts += 1;
    const stake = stakeOnChain(
      await api.get<GetProviderStakeResponseDto>('/api/v1/providers/me/stake'),
      SOLANA_DEVNET,
    );

    // Never a matter of lag: the stake authority on the row is what step 1
    // proved and what both transactions were built against.
    if (stake.stakeAuthority !== expectedAuthority) {
      throw new Error(
        `the stake reading belongs to ${stake.stakeAuthority ?? '(none)'}, not to the key that ` +
          `signed both transactions (${expectedAuthority})`,
      );
    }
    // Wrong asset, or a scale the arithmetic cannot compare: neither is lag,
    // and `MoneyUtil` refuses both rather than converting.
    if (stake.staked && stake.staked.asset !== required.asset) {
      throw new Error(
        `deposited ${MoneyUtil.format(required)} but the stake source reports a balance in ` +
          `${stake.staked.asset} — the gate compares one asset and does not convert`,
      );
    }
    if (stake.staked && stake.staked.decimals !== required.decimals) {
      throw new Error(
        `the stake source quotes ${stake.staked.asset} at ${stake.staked.decimals} decimals and ` +
          `this run computed the requirement at ${required.decimals} — two scales for one asset ` +
          `is data corruption, not a shortfall`,
      );
    }
    // MORE than was deposited is not lag either: `open_stake` + one
    // `deposit_stake` is everything this run put on that account, so a larger
    // balance means something outside this run funded it, and every assertion
    // downstream would be measuring somebody else's money.
    if (stake.staked && MoneyUtil.greaterThan(toMoney(stake.staked), required)) {
      throw new Error(
        `deposited ${MoneyUtil.format(required)} but the stake source reports ` +
          `${MoneyUtil.format(toMoney(stake.staked))} — more than this run staked, so the ` +
          `account was funded by something other than ${MoneyUtil.format(required)} of deposit`,
      );
    }

    // Reset every iteration, so a run that reached the gate once and then
    // regressed to a stake problem reports the stake problem it is actually
    // stuck on. Only the gate branch below raises it back to `GATE`.
    lastReasonKind = 'STAKE';

    if (!stake.chainReadable) {
      lastReason = 'GET /providers/me/stake reports chainReadable=false';
    } else if (!stake.hasKnownStake || !stake.staked) {
      lastReason = 'the stake source has no reading for this provider yet';
    } else if (MoneyUtil.lessThan(toMoney(stake.staked), required)) {
      // LESS than was deposited *is* lag, and `0` is its commonest shape.
      // `open_stake` and `deposit_stake` land in different slots seconds apart,
      // so a node holding the first block and not the second returns the PDA
      // with `bonded = 0` — which arrives here as `hasKnownStake: true,
      // staked: "0"`, not as an absent reading. Treating that as a wrong-sized
      // deposit would accuse the deposit of being wrong on the one condition
      // waiting fixes. It is also the only reading the cache can pin: a "no
      // account" read *deletes* the entry, while this one is a success and is
      // served for the full 30-second freshness window.
      lastReason =
        `the stake source still reports ${MoneyUtil.format(toMoney(stake.staked))} of ` +
        `${MoneyUtil.format(required)} — short by ` +
        `${MoneyUtil.format(MoneyUtil.subtract(required, toMoney(stake.staked)))}`;
    } else {
      const check = await api.get<PublishCheckDto>(
        `/api/v1/providers/me/tool-bindings/${bindingId}/publish-check`,
      );
      const unmet = check.requirements.filter((requirement) => !requirement.met);
      if (unmet.length === 0) {
        return {
          stake: stake as ProviderChainStakeDto & { staked: MoneyDto },
          check,
          attempts,
          waitedMs: Date.now() - startedAt,
        };
      }
      lastReason = unmet
        .map((entry) => `${entry.requirement} (${entry.code}: ${entry.detail})`)
        .join('; ');
      lastReasonKind = 'GATE';
    }

    if (Date.now() - startedAt >= STAKE_VISIBILITY_TIMEOUT_MS) {
      // Reached the gate, and the gate refused for its own reasons. The stake
      // is not in question — the branch above only runs once the source
      // reports at least `required` and `chainReadable` — so none of the
      // stake-source guidance below applies, and printing it would send the
      // reader after a problem this run has already ruled out.
      if (lastReasonKind === 'GATE') {
        throw new Error(
          `the stake is fine — the source reports at least ${MoneyUtil.format(required)} and ` +
            `chainReadable=true — but the publish gate still refuses after ${attempts} read(s) ` +
            `over ${Date.now() - startedAt}ms on a requirement that is NOT the stake: ` +
            `${lastReason}. Waiting cannot fix a requirement nothing in this loop advances; ` +
            `whatever is unmet above has to be satisfied before publish is attempted. ` +
            `The gate's four requirements are TESTER_RUN, TESTER_PASSED, PAYOUT_ACCOUNT and ` +
            `STAKE_AT_MINIMUM — see publish-gate.ts.`,
        );
      }
      throw new Error(
        `${MoneyUtil.format(required)} is staked and confirmed on chain, but the publish gate ` +
          `still does not see it after ${attempts} read(s) over ` +
          `${Date.now() - startedAt}ms: ${lastReason}. ` +
          // The two things an operator would otherwise go and check first, and
          // both are already excluded.
          `Step 0b proved this deployment reads the chain before this run spent anything. ` +
          // The contradiction this failure is most likely to print, named so
          // nobody spends an afternoon on it. `chainReadable` comes from
          // ONCHAIN_STAKE_READER, which `getStake` calls directly;
          // `hasKnownStake` comes from PROVIDER_STAKE_SOURCE, whose chain
          // source SWALLOWS a failed RPC read (it warns and falls back to a
          // cached reading, or to nothing). So the two disagree exactly when
          // the source's own RPC is failing.
          `And chainReadable=${stake.chainReadable} does NOT contradict a missing reading: that ` +
          `flag is a different reader. OnChainProviderStakeSource swallows a failed RPC read ` +
          `— it warns and falls back to cache or to absent — so "no reading" with ` +
          `chainReadable=true is what a stake-source RPC failure looks like from out here. ` +
          `Check the API server log for "On-chain stake read failed".`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, STAKE_VISIBILITY_POLL_MS));
  }
}

/**
 * Runs one step and records its outcome — both outcomes.
 *
 * `fn` returns the detail string for the `OK` record, so recording is not
 * something a step can forget to do: a step that returns is recorded as OK, a
 * step that throws is recorded as FAILED and the throw continues (the suite
 * fails fast, but the on-disk report now names the step that broke
 * rather than being silent about the only run anyone needed it for).
 *
 * `httpStatus` is filled in whenever the failure came off the wire, which is
 * most of them — `AcceptanceHttpError` is the only error in this suite that
 * knows a status code, and `StepEvidence` has had the field with no producer.
 */
async function step(
  report: AcceptanceReport,
  name: string,
  fn: () => Promise<string>,
): Promise<void> {
  let detail: string;
  try {
    detail = await fn();
  } catch (error) {
    report.record({
      step: name,
      status: 'FAILED',
      // Not `(error as Error).message` — a non-`Error` throw would record
      // `detail: undefined`, i.e. a FAILED entry that says nothing.
      detail: error instanceof Error ? error.message : String(error),
      ...(error instanceof AcceptanceHttpError ? { httpStatus: error.status } : {}),
    });
    throw error;
  }
  report.record({ step: name, status: 'OK', detail });
}

/**
 * Sign a challenge's `message` VERBATIM and return the base58 signature.
 *
 * The verbatim part is the whole point and it is a trap that has already been
 * paid for once: the backend re-derives the exact
 * byte sequence it handed out and verifies against *that*, so a locally
 * rebuilt string that differs by a character — or by a message version — fails
 * every time with a signature error that reads like a key problem.
 *
 * Both wallet proofs in step 1 go through here rather than each carrying its
 * own copy, because the *only* thing that legitimately differs between them is
 * which endpoint issued the challenge.
 */
async function signChallenge(
  signer: KeyPairSigner,
  challenge: { readonly message: string },
): Promise<string> {
  const signature = await signBytes(
    signer.keyPair.privateKey,
    new TextEncoder().encode(challenge.message),
  );
  return getBase58Decoder().decode(signature);
}

/**
 * Step 1 (provider registration): register the calling organization as a provider,
 * then prove that `ctx.provider.signer` — a real, funded devnet keypair —
 * controls **both** wallets the platform binds to it: the stake authority that
 * will back its on-chain stake, and the payout address its earnings settle to.
 *
 * Nothing here touches the chain. Registering is a Postgres write and proving
 * is an ed25519 signature check; `ProviderStakeAuthorityService.prove` reads
 * the chain only when *rotating* an existing authority, and this is always a
 * first proof. (The 0.05 SOL that funds the fresh keypair is
 * `generateFundedSigner`'s, spent before this step runs.)
 *
 * ## Two proofs, because two gates read two columns
 *
 * The stake authority and the payout address are separate values written by
 * separate endpoints — and since multichain support they are two columns on the
 * same row: `provider_chain_enrolments` carries both, one row per chain. The
 * publish gate consults both —
 * `evaluateStakeGate` and `evaluatePayoutGate`. Proving one and not the other
 * produces a provider that looks fully onboarded (`status: ACTIVE`, a proved
 * wallet on screen) and cannot publish a `PAID` binding, which is exactly the
 * shape this suite exists to catch. See the inline note at the payout proof
 * for the change that made it load-bearing.
 *
 * ## What is asserted, and why it is the proof and not the status
 *
 * The load-bearing check is that `stakeAuthority` came back as the CAIP-10
 * form of the address this run actually signed with. That is the property
 * real stake exists to guarantee — the platform binds an organization to the
 * pubkey that *proved* control, so a slash attestation cannot be pointed at
 * someone else's PDA — and it is the one an empty or absent value would
 * quietly break while the run stayed green.
 *
 * The registration `status` is checked too, but it is not the criterion:
 * `ProviderRegistrationService.register` writes `ProviderStatus.ACTIVE`
 * unconditionally (`provider-registration.service.ts`), so within one run it
 * cannot come back as anything else. It is asserted as a cheap guard against a
 * future milestone introducing an approval state, not as evidence of this one.
 *
 * `GetProviderRegistrationResponseDto` does not project the
 * enrolment's `stake_authority_account_id` column at all, which is why the proof is
 * confirmed from `POST /providers/me/stake-authority`'s own response — the
 * backend's statement that it wrote the trio — rather than read back.
 */
async function runStep1(ctx: SuiteContext): Promise<string> {
  const { api, signer } = ctx.provider;

  const registration = await api.post<RegisterProviderResponseDto>('/api/v1/providers', {
    legalName: 'Devnet Acceptance Provider',
    technicalContact: { name: 'Acceptance Bot', email: 'accept-tech@example.test' },
    ownerContact: { name: 'Acceptance Owner', email: 'accept-owner@example.test' },
    timezone: 'Europe/Paris',
    acceptedTerms: currentTermsVersions(),
  } satisfies RegisterProviderBodyDto);

  const address = signer.address;
  const expectedAccount = toAccountId(SOLANA_DEVNET, address);

  const challenge = await api.post<CreateStakeAuthorityChallengeResponseDto>(
    '/api/v1/providers/me/stake-authority/challenge',
    { chainId: SOLANA_DEVNET, address },
  );

  const proof = await api.post<ProveStakeAuthorityResponseDto>(
    '/api/v1/providers/me/stake-authority',
    { challengeId: challenge.challengeId, signature: await signChallenge(signer, challenge) },
  );

  if (proof.stakeAuthority !== expectedAccount) {
    throw new Error(
      `stake authority proved as "${proof.stakeAuthority ?? '(absent)'}" but the key that ` +
        `signed the challenge is ${expectedAccount}`,
    );
  }

  // The SECOND wallet proof, and as much a part of step 1's "prove the
  // wallet" as the first. It is a separate challenge with its own
  // message version — `PAYOUT_ADDRESS_MESSAGE_VERSION`, never the stake tag —
  // so the two proofs cannot be substituted for one another even though this
  // run signs both with the same key. A real provider would typically prove a
  // different address here; one key is enough to exercise the path, and no
  // rule forbids reusing it.
  //
  // Skipping this is what made step 4 unpassable: `PAYOUT_ACCOUNT` became the
  // publish gate's fourth requirement when the provider began to be paid on the
  // rail-A path (2026-08-25), and `evaluatePayoutGate` exempts only `FREE`
  // bindings — step 3 builds a `PAID` one. Between that change and this fix no
  // full 0→8a pass had run: steps 8b/9 were proved the same afternoon through
  // `--resume`, which enters at step 8b and never reaches the gate. A suite
  // that only ever runs its own tail cannot see its own head rot.
  const payoutChallenge = await api.post<CreatePayoutChallengeResponseDto>(
    '/api/v1/providers/me/payout-address/challenge',
    { chainId: SOLANA_DEVNET, address },
  );

  const payoutProof = await api.post<ProvePayoutAddressResponseDto>(
    '/api/v1/providers/me/payout-address',
    {
      challengeId: payoutChallenge.challengeId,
      signature: await signChallenge(signer, payoutChallenge),
    },
  );

  if (payoutProof.payoutAccountId !== expectedAccount) {
    throw new Error(
      `payout address proved as "${payoutProof.payoutAccountId ?? '(absent)'}" but the key ` +
        `that signed the challenge is ${expectedAccount}`,
    );
  }

  const after = await api.get<GetProviderRegistrationResponseDto>(
    '/api/v1/providers/me/registration',
  );
  if (after.registration.status !== ProviderStatus.ACTIVE) {
    throw new Error(
      `provider ${registration.id} registered but GET /providers/me/registration reports ` +
        `status=${after.registration.status}, expected ${ProviderStatus.ACTIVE}`,
    );
  }

  // `PAYOUT_WALLET` is the onboarding model's step 2 of 4 and it is now DONE,
  // so the first non-DONE step must have moved past it. Asserting the ordinal
  // rather than the step list keeps this honest without duplicating
  // `buildSteps`: a run that reports `2/4` here proved nothing the gate wants.
  const payoutStep = after.steps.find(
    (candidate) => candidate.key === ProviderOnboardingStepKey.PAYOUT_WALLET,
  );
  if (payoutStep?.status !== OnboardingStepStatus.DONE) {
    throw new Error(
      `the payout address proved as ${payoutProof.payoutAccountId}, but the onboarding step ` +
        `${ProviderOnboardingStepKey.PAYOUT_WALLET} reports ${payoutStep?.status ?? '(absent)'} ` +
        `— the publish gate reads the provider row, so a disagreement here is the gate's too`,
    );
  }

  return (
    `provider=${registration.id} status=${after.registration.status} ` +
    `step=${after.currentStep}/${after.totalSteps} stakeAuthority=${proof.stakeAuthority} ` +
    `payoutAccount=${payoutProof.payoutAccountId}`
  );
}

/**
 * Step 2 (connectivity check): declare the provider's endpoint, which the backend refuses
 * to save unless it can reach it from the platform's own egress.
 *
 * `PUT /providers/me/endpoint` is check-and-save in one call
 * (`ProviderConnectivityService.declareEndpoint`): it runs the probe, and on
 * anything other than `REACHABLE` it throws `PROVIDER_CONNECTIVITY_CHECK_FAILED`
 * and writes nothing. So a non-`REACHABLE` outcome arrives here as a 4xx, not
 * as a payload — which is exactly why the outcome is still asserted below
 * rather than trusted. `POST /providers/me/connectivity-check` is the
 * read-only sibling that *does* return a failing outcome as a 200 body; this
 * step deliberately uses the writing one, because the run needs the endpoint
 * persisted for the tool binding a later step creates.
 *
 * ## What the three assertions are each for
 *
 * `saved` is set by the controller as a literal `true` on this route and is
 * absent on the read-only sibling. Asserting it therefore proves *which route*
 * answered — a suite pointed at a build where the two routes had been
 * merged, or where `PUT` had quietly become a dry run, would otherwise stay
 * green while nothing was written. It is a cheap guard on the response's
 * identity, not evidence about the database; `runStep1`'s status check is
 * there for the same reason.
 *
 * The endpoint that comes back is compared to the one sent, and that check has
 * a job downstream rather than being merely defensive: the later steps that
 * build tool bindings need each binding's `endpoint` to match what the provider
 * row holds, and they take that value from {@link PROVIDER_ENDPOINT} — the
 * constant — rather than reading it back off an API response. This comparison
 * is what licenses that. It is the one moment in the run where the constant is
 * checked against what the backend actually probed and stored, so if the two
 * ever diverge (a normalized or defaulted URL, a trailing slash) it fails here,
 * at the step that declared it, instead of surfacing later as a binding pointed
 * at an endpoint the provider row does not have. Do not delete it as
 * redundant — the constant's trustworthiness is exactly what it buys.
 */
async function runStep2(ctx: SuiteContext): Promise<string> {
  const result = await ctx.provider.api.put<CheckConnectivityResponseDto>(
    '/api/v1/providers/me/endpoint',
    { endpoint: PROVIDER_ENDPOINT } satisfies DeclareEndpointBodyDto,
  );

  if (result.outcome !== ConnectivityOutcome.REACHABLE) {
    throw new Error(
      `connectivity for ${PROVIDER_ENDPOINT} came back ${result.outcome ?? '(absent)'}, expected ` +
        `${ConnectivityOutcome.REACHABLE} (failureCode=${result.failureCode ?? 'none'} ` +
        `detail=${result.detail ?? 'none'})`,
    );
  }

  if (result.saved !== true) {
    throw new Error(
      `PUT /providers/me/endpoint reported saved=${String(result.saved)} for ` +
        `${PROVIDER_ENDPOINT} — the probe passed but the endpoint was not stored`,
    );
  }

  if (result.endpoint !== PROVIDER_ENDPOINT) {
    throw new Error(
      `declared ${PROVIDER_ENDPOINT} but the check reports endpoint=${result.endpoint}`,
    );
  }

  return (
    `endpoint=${result.endpoint} outcome=${result.outcome} saved=${result.saved} ` +
    `status=${result.statusCode ?? 'none'} latencyMs=${result.latencyMs ?? 'none'}`
  );
}

/**
 * The same `GET`, keyed so that `HttpCacheInterceptor` cannot answer it from a
 * previous one.
 *
 * `generateAutoCacheKey` folds `path + sorted query string + tenant` into the
 * key, so a parameter no handler reads still separates two otherwise identical
 * reads. Use it on any `GET` whose *freshness* is the thing being asserted —
 * a before/after pair, or a read taken immediately after a write.
 *
 * It is not a general-purpose wrapper: `api.get` is right everywhere else, and
 * a suite that busted the cache on every read would stop exercising the cache
 * a real client actually gets. Two conditions have to hold at the call site,
 * and both are cheap to check: the route takes no `@Query()` DTO (the global
 * ValidationPipe runs `forbidNonWhitelisted`, so a route that *does* would
 * `400`), and the extra parameter cannot reach a query the handler builds.
 */
function uncacheable(path: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}_fresh=${randomBytes(6).toString('hex')}`;
}

/**
 * The calling organization's whole ledger position, as one comparable string.
 *
 * ## Why not just the total
 *
 * `AccountBalanceDto.total` is `available + held + pending`, so **a hold does
 * not move it**: reserving money against an in-flight call shifts `available`
 * into `held` and leaves the sum exactly where it was. A hold is also the most
 * likely way a tester run could ever touch money — it is the first thing a real
 * paid call does — so comparing totals would be a check that cannot see the
 * failure it exists to catch. Every bucket is compared instead, which is also
 * what `binding-mapping-tester.service.ts` claims of itself in prose: the
 * balances are byte-identical before and after a run.
 *
 * ## Why an empty ledger is still a real comparison
 *
 * A fresh provider organization has no balance rows, so both readings are
 * usually `{"balances":[],"withheld":[]}` — and that is not two numbers that
 * could never move. `AccountBalanceRepository.ensureRows` materialises a zero
 * snapshot row the first time *any* journal entry is written for an
 * `(account, asset)` pair, so a first-ever ledger write **adds a row to this
 * payload** rather than being invisible to it. `withheld` comes along for the
 * same reason one step further out: it joins the journal against
 * `payment_intents`, so an intent this step must not have created would show up
 * there even before any money moved.
 *
 * ## Why each row is sorted by its own serialized form
 *
 * `GET /balances` has **no stable row order**: it comes from
 * `AccountBalanceRepository.findAllRows`, which is `findBy({ organizationId })`
 * with no `ORDER BY`, so Postgres may hand back two reads in different orders —
 * and an `UPDATE` that moves a heap row is exactly the kind of thing that
 * changes it. Comparing the payloads as they arrive would report a movement
 * that never happened.
 *
 * Sorting by *asset* is not enough either: one organization holds one row per
 * `(account, asset)` pair, and `AccountBalanceDto` carries no account id — so a
 * buyer org with two accounts in the same asset (which the seeded demo org
 * already has) would leave the tie broken by the arrival order this is trying
 * to normalize away. Sorting each row by its own serialization is a total
 * order, and two rows that serialize identically are interchangeable anyway.
 *
 * The serialized form is the **sort key only** — the rows themselves go into
 * the result as objects, so the payload is stringified once. Stringifying each
 * row and then the wrapper escapes every quote twice and doubles the length of
 * a string that is read by a human on the only run that matters.
 *
 * ## Why the read is deliberately un-cacheable
 *
 * A fingerprint exists only to be compared against another one, and
 * {@link HTTP_GET_CACHE_TTL_MS} is the standing way for two such reads to come
 * back byte-identical **because they are the same read**. `HttpCacheInterceptor`
 * keys on `path + sorted query + tenant`, so a nonce in the query makes every
 * call a guaranteed cache MISS and therefore a genuine trip to Postgres. It is
 * a cache-buster and it is here on purpose: "nothing moved" served out of the
 * entry that the *first* read populated is not evidence of anything.
 *
 * `GET /balances` takes no `@Query()` DTO, so the global
 * `forbidNonWhitelisted` ValidationPipe never sees the parameter and the
 * handler ignores it.
 */
async function ledgerFingerprint(api: ReturnType<typeof createApiClient>): Promise<string> {
  const snapshot = await api.get<GetBalancesResponseDto>(uncacheable('/api/v1/balances'));
  const canonical = <T>(rows: readonly T[]): T[] =>
    [...rows].sort((a, b) => {
      const [left, right] = [JSON.stringify(a), JSON.stringify(b)];
      return left < right ? -1 : left > right ? 1 : 0;
    });
  return JSON.stringify({
    balances: canonical(snapshot.balances),
    withheld: canonical(snapshot.withheld),
  });
}

/**
 * Step 3 (binding editor and mapping tester): author a paid binding against the seeded tool, run
 * the mapping tester at it for real, and prove the run cost nobody anything.
 *
 * The binding is `DRAFT` when this step ends — publishing is step 4's, and
 * `BindingEditorService.create` refuses to write anything else
 * (`chk_tool_bindings_active_is_published` refuses it a second time at the row).
 *
 * ## The settlement asset is asked for, not assumed
 *
 * `assetId` comes from `GET …/tool-bindings/catalogue`, the deployment's own
 * answer, rather than from `ASSET_IDS.USDC_SOLANA_DEVNET`. That constant
 * resolves `SOLANA_DEVNET_USDC_MINT` **at module load** (`asset-registry.ts`),
 * which for this script is before `.env.local` has reached `process.env` at all
 * — see the file header. On a machine that overrides the mint there, the
 * constant and the server would name two different assets, the create would
 * 400 with `CHAIN_ASSET_NOT_REGISTERED`, and the message would be about an
 * asset nobody chose. The same read confirms the tool is actually seeded, which
 * turns a `PROVIDER_BINDING_TOOL_UNKNOWN` 404 into a sentence naming the seed
 * command.
 *
 * ## What each assertion after the tester is for
 *
 * The **ledger** check is step 3's *"the ledger is unchanged"*, and it is
 * asserted before the tester's own outcome deliberately: "the tester charges
 * nobody" has to hold on a red run as much as a green one, and asserting the
 * green first would let a run that moved money exit on the other message. See
 * {@link ledgerFingerprint} for why the comparison can actually fail.
 *
 * The **revision** check is what makes the tester run publishable at all. The
 * publish gate does not ask "has this binding ever passed" — it asks whether
 * the newest run is *for the revision that would go live* — so a report whose
 * `mappingVersion` is not the row's is a green tick the gate will refuse, and
 * finding that out here beats finding it out in step 4.
 *
 * The **publish-check** read is the gate's own verdict on both of the above,
 * from the code path that will actually refuse a publish. `STAKE_AT_MINIMUM` is
 * asserted **unmet** rather than ignored: nothing has been staked yet, so a
 * `publishable: true` here would mean step 4's stake proves nothing — a gate
 * answering a different question from the one asked, which is the reason this
 * run mints a fresh identity and a fresh price in the first place.
 *
 * What makes it unmet at this point is that the stake is **unresolvable**, not
 * that a shortfall was measured: a provider who has never staked has no stake
 * reading at all, so `evaluateStakeGate` fails closed with `STAKE_UNKNOWN` and
 * `detail` says so rather than naming a number. The requirement's `code` and
 * `detail` are both recorded verbatim below — the shortfall figure the gate
 * *can* produce is the one worth having in the report when it exists, and
 * copying the gate's own words is what keeps this step from claiming to have
 * seen something it did not.
 *
 * ## The second binding, and why "create + test" is still not shared
 *
 * {@link runStep8Seed} creates a **second** binding under this same provider —
 * its own tool, its own low fixed price — and publishes it through the same
 * {@link runProviderPublishFlow} this step ends with. The *publish* half is
 * therefore shared; "create a priced binding and run the tester" deliberately is
 * not. The two differ in every input that matters — tool, endpoint, both
 * mappings, tester input, price rule (random and above the floor's reach here,
 * fixed and deliberately tiny there) — and the assertions differ too: this step
 * asserts `STAKE_AT_MINIMUM` is **unmet**, step 8 relies on it already being
 * met. A helper spanning both would be a parameter list with a flag per caller,
 * which is a worse artefact than two explicit call sites.
 *
 * ## If the tester comes back red
 *
 * A known timestamp-timezone defect is still open: `FRESHNESS` parses an
 * offset-less provider timestamp as **local** time, so on a non-UTC host it
 * strikes an honest provider by the host's offset. {@link PROVIDER_ENDPOINT}
 * and this tool were chosen to route around it honestly — `$.date` is a
 * calendar date with no clock in it — but if it fires anyway, this step fails
 * with the layer and code that failed, and the run stops there.
 * Do not pick a different tool to make it green; that would hide a defect the
 * platform still has.
 */
async function runStep3(ctx: SuiteContext): Promise<string> {
  const { api } = ctx.provider;

  const catalogue = await api.get<ToolCatalogueDto>('/api/v1/providers/me/tool-bindings/catalogue');
  const tool = catalogue.tools.find((candidate) => candidate.id === ACCEPTANCE_TOOL_ID);
  if (!tool) {
    throw new Error(
      `tool ${ACCEPTANCE_TOOL_ID} (get_usd_eur_rate) is not in this deployment's catalogue — ` +
        `seed it with \`yarn demo:seed\`, which loads scripts/mcp/seed/catalogue.json. ` +
        `On offer: [${catalogue.tools.map((candidate) => candidate.id).join(', ')}]`,
    );
  }

  const priceAmount = randomBindingPriceMinor();
  const binding = await api.post<SavedToolBindingDto>('/api/v1/providers/me/tool-bindings', {
    toolId: ACCEPTANCE_TOOL_ID,
    // NOT inherited from the provider row — `tool_bindings.endpoint` is its own
    // column and the create body requires it. Step 2's third assertion is what
    // licenses reaching for the constant here instead of reading it back.
    endpoint: PROVIDER_ENDPOINT,
    requestMapping: ACCEPTANCE_REQUEST_MAPPING,
    responseMapping: ACCEPTANCE_RESPONSE_MAPPING,
    pricingMode: PricingMode.PAID,
    priceAmount,
    assetId: catalogue.settlementAsset.assetId,
    // The chains this binding is offered on. `SOLANA_DEVNET` is
    // the constant every other step of this suite provisions against (the
    // payout enrolment, the stake account, the deposit), so the binding is
    // offered exactly where the run has put money.
    settlementChains: [SOLANA_DEVNET],
    slaFailureRate: 0.02,
    timeoutMs: 10_000,
    authMode: BindingAuthMode.NONE,
  } satisfies SaveToolBindingBodyDto);

  // The price is read back rather than trusted: `create` writes `'0'` for a
  // `FREE` binding regardless of what was sent, so an echo that does not match
  // is the difference between a binding the stake gate has to work for and one
  // it waves through.
  if (binding.price.amount !== priceAmount) {
    throw new Error(
      `binding ${binding.id} was created at price ${binding.price.amount} ` +
        `${binding.price.asset}, but ${priceAmount} was sent as ${PricingMode.PAID}`,
    );
  }
  if (binding.status !== BindingStatus.DRAFT) {
    throw new Error(
      `a freshly created binding must be ${BindingStatus.DRAFT} — publishing is a separate, ` +
        `gated step — but ${binding.id} came back ${binding.status}`,
    );
  }

  const ledgerBefore = await ledgerFingerprint(api);
  const test = await api.post<BindingTestReportDto>(
    `/api/v1/providers/me/tool-bindings/${binding.id}/test`,
    { input: {} } satisfies RunBindingTestBodyDto,
  );
  const ledgerAfter = await ledgerFingerprint(api);

  if (ledgerAfter !== ledgerBefore) {
    throw new Error(
      `the ledger moved across a mapping-tester run (outcome ${test.outcome}) — the tester ` +
        `writes no payment intent, no hold and no journal entry, so this is a real defect. ` +
        `before=${ledgerBefore} after=${ledgerAfter}`,
    );
  }

  if (test.outcome !== BindingTestOutcome.PASSED) {
    const layers = test.layers
      .map((layer) => `${layer.layer}=${layer.status}${layer.code ? `(${layer.code})` : ''}`)
      .join(' ');
    throw new Error(
      `mapping tester came back ${test.outcome} at the ${test.failedLayer ?? 'unknown'} layer ` +
        `for binding ${binding.id}: ${layers}. ` +
        `Details: ${test.layers
          .filter((layer) => layer.detail)
          .map((layer) => `${layer.layer}: ${layer.detail}`)
          .join(' | ')}`,
    );
  }

  if (test.mappingVersion !== binding.version) {
    throw new Error(
      `the tester ran against revision ${test.mappingVersion} but the binding stores revision ` +
        `${binding.version} — the publish gate wants a run for the revision that would go live`,
    );
  }

  const check = await api.get<PublishCheckDto>(
    `/api/v1/providers/me/tool-bindings/${binding.id}/publish-check`,
  );
  const requirementOf = (requirement: PublishRequirement) => {
    const result = check.requirements.find((entry) => entry.requirement === requirement);
    if (!result) {
      throw new Error(
        `publish-check for ${binding.id} carries no ${requirement} entry — the gate returns at ` +
          `least one entry per requirement, always (one per failing settlement chain when it is ` +
          `unmet). Got [${check.requirements.map((entry) => entry.requirement).join(', ')}]`,
      );
    }
    return result;
  };

  for (const requirement of [PublishRequirement.TESTER_RUN, PublishRequirement.TESTER_PASSED]) {
    const result = requirementOf(requirement);
    if (!result.met) {
      throw new Error(
        `${requirement} is unmet after a ${test.outcome} tester run at revision ` +
          `${test.mappingVersion} (gate is judging revision ${check.mappingVersion}): ` +
          `${result.code} — ${result.detail}`,
      );
    }
  }

  const stake = requirementOf(PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN);
  if (stake.met) {
    throw new Error(
      `${PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN} is already met for binding ${binding.id} at price ` +
        `${binding.price.amount} ${binding.price.asset}, before anything has been staked. The ` +
        `stake step would then prove nothing — check whether this ` +
        `provider carries a minimumStakeOverride`,
    );
  }

  ctx.binding = { id: binding.id, price: binding.price };

  return (
    `binding=${binding.id} tool=${tool.id} price=${binding.price.amount} ` +
    `(${binding.price.asset}) status=${binding.status} revision=${test.mappingVersion} ` +
    `tester=${test.outcome} callId=${test.callId} upstream=${test.upstream?.status ?? 'none'} ` +
    `in ${test.upstream?.latencyMs ?? '?'}ms verdict=${test.verification?.verdict ?? 'none'} ` +
    `(${test.verification?.policySource ?? 'none'}) mapped=${JSON.stringify(test.mapped)} ` +
    `${PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN} still unmet (${stake.code}: ${stake.detail}) ` +
    `ledger unchanged across the run: ${ledgerBefore}`
  );
}

/**
 * Step 4 (stake and publish check): open a stake account, fund it to exactly what the
 * binding's price demands, and publish the binding the stake has just unlocked.
 *
 * **This is the first step that spends.** Two real devnet transactions, both
 * paid for by `ctx.provider.signer`: rent-exemption for a `ProviderStake` PDA,
 * and a transfer of `max($50, 1000 × price)` of the devnet USDC standin into
 * the program's stake vault. Neither is recoverable inside the same run — the
 * unbonding period on this deployment is 12 days.
 *
 * ## The backend builds; this script signs and sends
 *
 * Both intents come back **unsigned**, with every signature slot empty, and
 * there is no endpoint anywhere that would take a signed one back. That is
 * structural rather than a convention — see {@link signAndBroadcast}, which is
 * where the argument lives. Do not add a submit route to satisfy a later step.
 *
 * ## Open first, then deposit — enforced, not merely conventional
 *
 * `open_stake` is deliberately not `init_if_needed` (*"an initializer that can
 * run on an existing account is the shape reinitialisation attacks are made
 * of"*), and `deposit_stake` requires an already-existing account. The backend
 * refuses the wrong order before it costs a fee:
 * `PROVIDER_STAKE_ACCOUNT_NOT_OPEN` for a deposit against nothing,
 * `..._ALREADY_OPEN` for a second open, and
 * `PROVIDER_STAKE_AUTHORITY_UNPROVEN` for either before step 1 has run.
 *
 * ## Why the deposit is *exactly* the minimum and not a comfortable margin
 *
 * The amount is {@link requiredStakeFor}'s, computed with the router's own
 * `minimumStakeFor`, and it is deposited to the atomic unit. Staking a round
 * `$100` over a `$67` requirement would pass the gate just as well and would
 * prove strictly less: at equality, `MoneyUtil.greaterThanOrEqual(staked,
 * minimum)` is the *only* thing standing between unmet and met, so a green run
 * pins the boundary rather than clearing it by an amount nobody chose. It also
 * means a deployment whose `PROVIDER_MINIMUM_STAKE_FLOOR` or
 * `PROVIDER_MINIMUM_STAKE_MULTIPLE` disagrees with this script fails here,
 * loudly, with the gate's own shortfall figure in the message — instead of
 * being papered over by slack.
 *
 * ## What makes a green run evidence that the stake did the work
 *
 * Step 3 ends by asserting `STAKE_AT_MINIMUM` is **unmet**, and records the
 * gate's reason verbatim (`STAKE_UNKNOWN` — a provider who has never staked has
 * no reading at all, so the gate fails closed rather than measuring a
 * shortfall). Between that assertion and this step's, the only things that
 * happen are the two transactions below: no mapping is edited, no revision
 * moves, the tester is not re-run. This step therefore asserts the flip
 * end-to-end —
 *
 * ```text
 *   GET /providers/me/stake   staked == the deposit, chainReadable, from the CHAIN
 *   publish-check             all three met, publishable: true
 *   POST …/publish            ACTIVE, at the revision the tester ran
 * ```
 *
 * — and the report's step-3 and step-4 lines, read together, are the before and
 * after. The `GET /providers/me/stake` read in the middle is what makes it
 * unambiguous: it shows the *source the gate reads* returning the number this
 * run put on the chain, so "the gate flipped" cannot be satisfied by anything
 * else having changed. Step 0b has already established that the source is the
 * chain at all.
 *
 * The first two of those are read through {@link awaitStakeVisibleToGate}
 * rather than once each, because a confirmed deposit reaches the gate
 * eventually rather than immediately — a race this step hit on its first live
 * run, and which that function documents in full. The wait is reported.
 *
 * ## The publish half is shared
 *
 * From `publish-check` onwards this function was binding-shaped rather than
 * provider-shaped, and it is now {@link runProviderPublishFlow} — called from
 * here and from {@link runStep8Seed}, whose second, cheaper binding needs
 * exactly that half and none of the staking. One provider opens one stake
 * account, and `minimumStakeFor` is a `max` over ACTIVE bindings rather than a
 * `sum`, so a *lower*-priced second binding raises the bar not at all.
 */
async function runStep4(ctx: SuiteContext): Promise<string> {
  const { api, signer } = ctx.provider;
  if (!ctx.binding) {
    throw new Error('step 4 needs step 3’s binding, and ctx.binding is unset');
  }
  const { id: bindingId, price } = ctx.binding;

  // ── Open the stake account ────────────────────────────────────────────────
  // No body: `open_stake` carries no argument and moves no tokens, and
  // `CreateStakeIntentBodyDto` is deliberately not accepted on this route.
  const openIntent = await api.post<CreateStakeIntentResponseDto>(
    '/api/v1/providers/me/stake/open-stake-intent',
  );
  if (openIntent.amount !== null) {
    throw new Error(
      `open-stake-intent carries an amount (${JSON.stringify(openIntent.amount)}) — the ` +
        `instruction has none, and a transaction that moves tokens is not what was asked for`,
    );
  }
  const openTransaction = assertStakeIntent(openIntent, StakeIntentKind.OPEN_STAKE, signer);
  const openSignature = await signAndBroadcast(ctx.sender, signer, openTransaction, 'open_stake');

  // ── Fund it to the binding's requirement ──────────────────────────────────
  const required = requiredStakeFor(price);
  const depositIntent = await createDepositIntent(api, required, openSignature);
  if (!depositIntent.amount || depositIntent.amount.amount !== required.amount) {
    throw new Error(
      `asked to deposit ${required.amount} and the intent carries ` +
        `${depositIntent.amount?.amount ?? '(none)'}`,
    );
  }
  // The asset is the chain's, not this request's: the backend denominates every
  // stake intent in `Config.stake_mint` and accepts no asset field. If that
  // mint is not the asset the binding is priced in, the deposit would land in a
  // token the stake gate does not measure — a transaction that succeeds on
  // chain and moves the gate not at all.
  if (depositIntent.amount.asset !== price.asset) {
    throw new Error(
      `the chain's stake mint is ${depositIntent.amount.asset} but binding ${bindingId} is ` +
        `priced in ${price.asset} — depositing would fund a token the stake gate does not read`,
    );
  }
  const depositTransaction = assertStakeIntent(depositIntent, StakeIntentKind.DEPOSIT, signer);
  const depositSignature = await signAndBroadcast(
    ctx.sender,
    signer,
    depositTransaction,
    'deposit_stake',
  );

  // ── What the gate reads, once the chain has caught up ─────────────────────
  const settled = await awaitStakeVisibleToGate(api, bindingId, required, signer);
  const { stake } = settled;

  // The gate's verdict and the publish itself, through the shared flow — which
  // re-reads `publish-check` rather than reusing the one `awaitStakeVisibleToGate`
  // converged on. That is not a wasted round trip: the read above is a *loop
  // exit condition*, and asserting on a fresh read is what makes "the gate said
  // yes and then we published" one statement rather than two about different
  // moments.
  const { check, published } = await runProviderPublishFlow(ctx, bindingId);

  return (
    `stake account opened (${openSignature}) and funded with ` +
    `${MoneyUtil.format(required)} (${depositSignature}); source reports ` +
    `staked=${stake.staked.amount} ${stake.staked.asset} chainReadable=${stake.chainReadable} ` +
    `authority=${stake.stakeAuthority} observedAt=${stake.observedAt}; ` +
    `${PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN} flipped to met ` +
    `(it was unmet at step 3, with nothing but these two transactions in between) so ` +
    `publishable=true on all of [${check.requirements.map((entry) => entry.requirement).join(', ')}]` +
    `${settled.waitedMs > 0 ? `, after ${settled.attempts} reads over ${settled.waitedMs}ms` : ' on the first read'}; ` +
    `binding=${bindingId} status=${published.status} revision=${published.version} ` +
    `publishedAt=${new Date(published.publishedAt).toISOString()}`
  );
}

/** What {@link runProviderPublishFlow} saw and did, for the caller's report line. */
interface ProviderPublishResult {
  /** The gate's verdict, read immediately before the publish it licensed. */
  readonly check: PublishCheckDto;
  readonly published: PublishedToolBindingDto;
}

/**
 * Ask the publish gate, assert it said yes for the right reasons, publish, and
 * assert what came back — for **any** binding of this run's provider.
 *
 * Lifted out of `runStep4` when step 8 gained a second binding to publish, and
 * the shape of the lift is the point: everything here reads a binding id and
 * asserts on a gate verdict, and nothing here knows about a stake, a
 * transaction or a price. Step 4 stakes first and then calls this; step 8's
 * binding is cheaper than step 4's and clears the same requirement with the
 * stake already on chain (`minimumStakeFor` is a `max` over ACTIVE bindings,
 * never a `sum` — `provider-stake.service.ts`'s `STAKE_REQUIREMENT_RULE`), so it
 * calls this and nothing else.
 *
 * ## Why all three assertions, when `publishable` alone would do
 *
 * They answer different questions and they have failed apart:
 *
 * - **Every requirement met** is the one that names *what* is wrong when
 *   something is, with the gate's own `code` and `detail` — `publishable: false`
 *   on its own is a boolean nobody can act on.
 * - **`publishable` itself** is the field `POST …/publish` acts on. Every
 *   requirement met *and* `publishable: false` means the gate's two answers
 *   disagree, which no amount of reading the list would show.
 * - **No requirement missing from the list** is what stops the first assertion
 *   from being satisfiable by an empty list. A build that stopped returning an
 *   entry would otherwise turn "nothing unmet" into "nothing asked", which is
 *   the `gates-that-answer-a-different-question` shape exactly.
 *
 * The revision assertion after the publish is the same argument once more: the
 * gate judges a specific `mappingVersion`, and a binding that moved between the
 * check and the publish would go live on a revision no tester run covers.
 */
async function runProviderPublishFlow(
  ctx: SuiteContext,
  bindingId: string,
): Promise<ProviderPublishResult> {
  const { api } = ctx.provider;

  const check = await api.get<PublishCheckDto>(
    `/api/v1/providers/me/tool-bindings/${bindingId}/publish-check`,
  );

  const unmet = check.requirements.filter((requirement) => !requirement.met);
  if (unmet.length > 0) {
    throw new Error(
      `publish-check for ${bindingId} at revision ${check.mappingVersion} refuses ` +
        `${unmet.length} requirement(s): ` +
        `${unmet.map((entry) => `${entry.requirement} (${entry.code}: ${entry.detail})`).join('; ')}`,
    );
  }
  if (!check.publishable) {
    throw new Error(
      `publish-check for ${bindingId} reports every requirement met and publishable=false — ` +
        `[${check.requirements.map((entry) => entry.requirement).join(', ')}]`,
    );
  }
  const seen = new Set(check.requirements.map((entry) => entry.requirement));
  const missing = Object.values(PublishRequirement).filter((requirement) => !seen.has(requirement));
  if (missing.length > 0) {
    throw new Error(
      `publish-check for ${bindingId} carries no entry for [${missing.join(', ')}] — the gate ` +
        `returns one entry per requirement, always`,
    );
  }

  const published = await api.post<PublishedToolBindingDto>(
    `/api/v1/providers/me/tool-bindings/${bindingId}/publish`,
  );
  if (published.status !== BindingStatus.ACTIVE) {
    throw new Error(
      `binding ${bindingId} came back ${published.status} from publish, expected ` +
        `${BindingStatus.ACTIVE}`,
    );
  }
  if (published.version !== check.mappingVersion) {
    throw new Error(
      `published revision ${published.version} is not the revision the gate judged ` +
        `(${check.mappingVersion}) — the binding moved between the check and the publish`,
    );
  }
  if (!published.publishedAt) {
    throw new Error(`binding ${bindingId} is ACTIVE with no publishedAt`);
  }

  return { check, published };
}

/**
 * The two chain readings worth having when `POST …/settle` fails, folded into
 * the error that failed.
 *
 * Neither is an assertion — this runs only on a failure that has already
 * happened, and it exists because the three ways this step realistically breaks
 * all surface as errors that name none of them:
 *
 * - **The blockhash expired.** Devnet blocks land every ~211 ms, not the 400 ms
 *   everyone assumes, so the 150-block window is roughly **31 seconds** — less
 *   than half of {@link DEPOSIT_INTENT_TTL_MS}, which means the intent is still
 *   perfectly alive when the transaction it holds has stopped being sendable.
 *   Both ends of this have been measured: a 34-second
 *   create→settle failed with `BlockhashNotFound`, an 8.1-second one settled.
 *   So the elapsed time is reported on the failure whether or not it caused it.
 * - **The facilitator's fee payer is out of SOL.** The buyer signs as token
 *   owner only; somebody else pays the gas, and the screen promises *"Network
 *   fee $0.00 — the facilitator sponsors the transaction"*. That account has
 *   been at zero and unfunded before. It is a provisioning gap, not a bug in
 *   this script, and the number says which.
 * - **The buyer's token account is not holding what was assumed** — the wrong
 *   mint (this run funded one mint and the server advertised another), or an
 *   ATA that was never created.
 *
 * Every read is individually guarded and the original error is always the last
 * thing in the message: a diagnostic that throws, or that buries what actually
 * failed, is worse than no diagnostic.
 *
 * An `AcceptanceHttpError` is re-raised **as one**, carrying its own status and
 * its own body beside the diagnostic. `step()` reads `httpStatus` off that class
 * and off nothing else, so wrapping a wire failure in a plain `Error` here would
 * trade the report's status code for a longer message.
 */
async function explainDepositSettleFailure(
  ctx: SuiteContext,
  settlePath: string,
  requirements: SolanaDepositRequirementsDto,
  buyerAta: string,
  elapsedMs: number,
  cause: unknown,
): Promise<Error> {
  const read = async (what: string, fn: () => Promise<string>): Promise<string> => {
    try {
      return await fn();
    } catch (error) {
      return `${what} unreadable (${error instanceof Error ? error.message : String(error)})`;
    }
  };

  const buyerBalance = await read(`buyer ATA ${buyerAta}`, async () => {
    const { value } = await ctx.sender.rpc.getTokenAccountBalance(address(buyerAta)).send();
    return `buyer ATA ${buyerAta} holds ${value.amount} of mint ${requirements.asset}`;
  });
  const feePayerBalance = await read(`fee payer ${requirements.feePayer}`, async () => {
    const { value } = await ctx.sender.rpc.getBalance(address(requirements.feePayer)).send();
    return (
      `facilitator fee payer ${requirements.feePayer} holds ${value} lamports` +
      `${value === 0n ? ' — ZERO, so it cannot sponsor anything. This is a provisioning gap, not a code defect: fund it.' : ''}`
    );
  });

  const diagnostic =
    `the deposit did not settle. create -> settle took ${elapsedMs}ms` +
    `${elapsedMs > BLOCKHASH_WINDOW_MS ? ` — PAST the ~${BLOCKHASH_WINDOW_MS / 1000}s devnet blockhash window, which is the first thing to suspect; the intent TTL is NOT the binding constraint here` : ''}. ` +
    `${buyerBalance}. ${feePayerBalance}`;

  if (cause instanceof AcceptanceHttpError) {
    return new AcceptanceHttpError(
      cause.status,
      { diagnostic, response: cause.body },
      'POST',
      settlePath,
    );
  }
  return new Error(
    `${diagnostic}. Underlying failure: ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
  );
}

/**
 * Waits for the settled deposit to become **spendable**, and returns the
 * balance row that says so.
 *
 * ## Why `SETTLED` is not the end of the story
 *
 * `settleDeposit` credits `DEPOSIT_PENDING`, and that entry's effect is
 * `{ available: 0, held: 0, pending: 1 }`. A green step 5 that stopped at the
 * settle response would therefore report a deposit that moved real money on
 * chain, an intent that says `SETTLED`, and a buyer with **`available: 0`** —
 * all three true, and the third is the one every later step depends on, because
 * `LedgerHoldService.createHold` reserves out of `available` and nothing else.
 * Step 7's paid call would fail on a hold it cannot take, naming a balance
 * rather than the process that never promoted it.
 *
 * That is the same shape this suite exists to catch, and it is why the wait is
 * here rather than left to the step that spends: `awaitStakeVisibleToGate` is
 * the established precedent — step 4 converges on the *gate* seeing the stake
 * rather than trusting that a confirmed write implied it.
 *
 * ## What it waits for, and what it refuses to do
 *
 * The promotion is a cron in the **scheduler process**, up to
 * {@link DEPOSIT_CREDIT_TIMEOUT_MS} away. This function polls `GET /balances`
 * and does nothing else — in particular it never writes a `DEPOSIT_CONFIRM`
 * itself. A suite that manufactured the entry it is meant to observe would be
 * asserting its own arithmetic.
 *
 * ## The one failure that is not a wait
 *
 * The same sweep writes `DEPOSIT_REJECT` when the transaction is no longer
 * observable at `finalized` commitment, and that entry's effect returns
 * `pending` to zero without ever crediting `available`. Waiting longer cannot
 * fix it. So a reading where `pending` has gone back to zero **after** having
 * held the deposit is diagnosed immediately, rather than spending six minutes
 * arriving at a timeout message about a cron that already ran.
 *
 * A fresh buyer organization has exactly one ledger account and no other money,
 * so the expected end state is exact: `available` equal to the deposit, `pending`
 * back to zero. Equality rather than "at least" — a different figure on a
 * one-deposit organization is something else having written, which is worth
 * failing on rather than accepting.
 */
async function awaitDepositCredited(
  api: ReturnType<typeof createApiClient>,
  expected: Money,
): Promise<{
  balance: AccountBalanceDto;
  attempts: number;
  waitedMs: number;
}> {
  const startedAt = Date.now();
  let attempts = 0;
  let sawPending = false;
  let lastReason = 'no read completed';

  for (;;) {
    attempts += 1;
    const snapshot = await api.get<GetBalancesResponseDto>('/api/v1/balances');
    const rows = snapshot.balances.filter((row) => row.asset === expected.asset);

    if (rows.length > 1) {
      throw new Error(
        `the buyer organization holds ${rows.length} balance rows in ${expected.asset}. A fresh ` +
          `organization has one ledger account, and AccountBalanceDto carries no account id — so ` +
          `there is no way to tell which of these this run's deposit landed in`,
      );
    }

    const [balance] = rows;
    if (!balance) {
      lastReason = `no ${expected.asset} balance row exists yet`;
    } else {
      // Checked before the arithmetic rather than left to it: `MoneyUtil`
      // refuses two operands of one asset at different scales, and its refusal
      // would arrive here as a `MONEY_*` error about operands rather than as a
      // sentence about the ledger quoting a scale the deposit was not made in.
      if (balance.available.decimals !== expected.decimals) {
        throw new Error(
          `the ledger quotes ${balance.asset} at ${balance.available.decimals} decimals and this ` +
            `run deposited at ${expected.decimals} — one asset at two scales is data corruption, ` +
            `not a balance that has not caught up`,
        );
      }
      const available = toMoney(balance.available);
      const pending = toMoney(balance.pending);

      if (!MoneyUtil.isZero(pending)) {
        sawPending = true;
      }

      if (MoneyUtil.equals(available, expected)) {
        if (!MoneyUtil.isZero(pending)) {
          lastReason =
            `available reached ${MoneyUtil.format(available)} but ${MoneyUtil.format(pending)} ` +
            `is still pending — DEPOSIT_CONFIRM moves the money OUT of pending, so both being ` +
            `non-zero means a second credit this run did not make`;
        } else {
          return { balance, attempts, waitedMs: Date.now() - startedAt };
        }
      } else if (MoneyUtil.greaterThan(available, expected)) {
        // Never lag: this organization was minted minutes ago and this run made
        // exactly one deposit into it.
        throw new Error(
          `the buyer's available balance is ${MoneyUtil.format(available)}, more than the ` +
            `${MoneyUtil.format(expected)} this run deposited — something outside this run ` +
            `credited a brand-new organization, and every later assertion would be measuring it`,
        );
      } else if (sawPending && MoneyUtil.isZero(pending)) {
        // The deposit was pending and is not any more, without becoming
        // available. Only one thing in the codebase does that.
        throw new Error(
          `the deposit left 'pending' without reaching 'available': the finality sweep wrote ` +
            `DEPOSIT_REJECT, which is what it does when the settlement transaction is no longer ` +
            `observable at FINALIZED commitment (deposit-finality.service.ts). The money moved ` +
            `on chain and the ledger has un-credited it. available=` +
            `${MoneyUtil.format(available)} pending=${MoneyUtil.format(pending)}. ` +
            `Waiting longer cannot change this — check the API server log for ` +
            `"no longer observable at finalized commitment".`,
        );
      } else {
        lastReason =
          `available=${MoneyUtil.format(available)} pending=${MoneyUtil.format(pending)} — the ` +
          `deposit is credited but not yet spendable`;
      }
    }

    if (Date.now() - startedAt >= DEPOSIT_CREDIT_TIMEOUT_MS) {
      throw new Error(
        `the deposit settled on chain but never became spendable: after ${attempts} read(s) ` +
          `over ${Date.now() - startedAt}ms, ${lastReason}. ` +
          `DEPOSIT_PENDING moves 'pending' only; 'available' is credited by DEPOSIT_CONFIRM, ` +
          `written ONLY by DepositFinalityService.promotePendingDeposits, whose only caller is ` +
          `DepositFinalityJob's @Cron(DEPOSIT_FINALITY_SWEEP_CRON = "${DEPOSIT_FINALITY_SWEEP_CRON}"). ` +
          `That job lives in PaymentSchedulerModule, which ONLY the scheduler process imports. ` +
          `So the overwhelmingly likely cause is that no scheduler is running: start one ` +
          `(SERVICE_TYPE=scheduler, or SERVICE_TYPE=all which boots it alongside the API). ` +
          `This suite requires it — see the file header. If a scheduler IS running, check its ` +
          `log for "Deposit finality sweep".`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, DEPOSIT_CREDIT_POLL_MS));
  }
}

/**
 * Step 5 (deposits): the buyer funds its platform balance with **real
 * devnet USDC standin**, over HTTP, gaslessly.
 *
 * ```text
 *   POST /deposits            -> intent + payTo/asset/decimals/feePayer/memo/blockhash
 *   build + partially sign    -> legacy transfer, owner signed, fee-payer slot EMPTY
 *   POST /deposits/:id/settle -> facilitator co-signs, pays gas, submits, observes
 * ```
 *
 * ## Over HTTP, deliberately, unlike `scripts/devnet/deposit.ts`
 *
 * That script proves the same path but calls `DepositService` **in process**,
 * against its own locally generated org and agent ids. It was written before
 * the routes existed and it is not what this suite is for: every other step
 * here goes through the live server, so the controllers, the guards, the DTO
 * validation and the session scoping are all under test. Only its
 * transaction-building half is shared, and it already lived in its own module
 * (`lib/build-deposit-payload.ts`) — the one thing that had to change is that
 * the blockhash is now *given* rather than fetched. See `DepositLifetime`.
 *
 * ## The order is the point: create → build → sign → settle, with nothing slow between
 *
 * The binding constraint is the **blockhash**, not the intent. Devnet produces
 * a block every ~211 ms rather than the 400 ms the tooling assumes, so the
 * 150-block window is about **31 seconds** — while `DEPOSIT_INTENT_TTL_MS` is
 * 90. An intent that is comfortably alive can therefore hold a transaction the
 * cluster will no longer accept, and the failure is `BlockhashNotFound`, an
 * error that names neither the deposit nor the clock. Measured: 34 s failed,
 * 8.1 s succeeded.
 *
 * Hence every response assertion below the `POST /deposits` call is **local** —
 * string comparisons on a payload already in hand, no I/O — and the derivation
 * of the buyer's associated token account is a hash, not a lookup. The elapsed
 * create→settle time is measured and reported on success as well as failure, so
 * a run that is drifting toward the window is visible before it crosses it.
 *
 * ## Partial signing is the design, not a shortcut
 *
 * The buyer signs as the transfer's owner and leaves the fee payer's slot
 * zeroed; the facilitator fills it, pays the gas and submits. That is what makes
 * this gasless for a wallet holding no SOL, and it is why there is no
 * `sendTransaction` anywhere in this step — unlike step 4, where the provider
 * pays their own gas and this script broadcasts.
 *
 * ## What is asserted, and why the amount is the load-bearing one
 *
 * `settledAmount` is **never** the requested amount echoed back: the SVM
 * `exact` scheme tolerates overpayment, so the server credits what the chain was
 * *observed* to move — the vault's own token-balance delta for that transaction,
 * read out of `preTokenBalances`/`postTokenBalances`. This step transfers
 * exactly {@link BUYER_DEPOSIT_AMOUNT_MINOR} and nothing else touches the vault
 * in that transaction, so the two must be equal to the atomic unit. Asserting
 * equality therefore checks the whole loop — what was asked for, what was
 * signed, and what the cluster says actually landed — rather than checking that
 * a number survived a round trip.
 *
 * ## And then the part `SETTLED` does not cover
 *
 * The step does not end at the settle response, because that response is not
 * what any later step needs. `settleDeposit` credits `DEPOSIT_PENDING`, which
 * moves `pending` alone; `available` — the only bucket a hold can be taken
 * against — arrives later, from the scheduler's finality sweep. Stopping at
 * `SETTLED` would leave a green step 5 handing step 7 a buyer with nothing
 * spendable. {@link awaitDepositCredited} converges on that instead, and both
 * buckets are printed in the detail so a reader of a green report can see the
 * split rather than infer it.
 *
 * A smaller wait is folded into the same poll and is worth not confusing
 * with the big one: the pending credit is not instantaneous, but that
 * one is milliseconds. The finality sweep is minutes, and it is the reason the
 * suite needs a scheduler at all — see the file header.
 */
async function runStep5(ctx: SuiteContext): Promise<string> {
  const { api, signer } = ctx.buyer;

  // ── create ────────────────────────────────────────────────────────────────
  // The clock starts here. Everything between this and the settle below is
  // either local or a hash — see the docstring.
  const startedAt = Date.now();
  const created = await api.post<CreateDepositResponseDto>('/api/v1/deposits', {
    amount: BUYER_DEPOSIT_AMOUNT_MINOR,
  } satisfies CreateDepositBodyDto);
  // `requirements` is a `oneOf` since the deposit path learned a second chain,
  // and every assertion below reads an SVM field. Narrowed with a refusal
  // rather than a cast: this suite runs against Solana devnet, so an `eip155`
  // answer here means the session's chain is not the one this run funded, and
  // "the blockhash is missing" is the wrong way to find that out.
  const requirements = created.requirements;
  if (requirements.namespace !== 'solana') {
    throw new Error(
      `POST /deposits answered with ${requirements.namespace} requirements — this suite funds a ` +
        `Solana devnet buyer and signs an SPL transfer, so there is nothing here that could ` +
        `honour a contract call. Check which chain the run's session is on.`,
    );
  }

  if (requirements.amount !== BUYER_DEPOSIT_AMOUNT_MINOR) {
    throw new Error(
      `asked to deposit ${BUYER_DEPOSIT_AMOUNT_MINOR} minor units and the requirements quote ` +
        `${requirements.amount} — signing those would transfer an amount nobody asked for`,
    );
  }
  // The memo is the binding between this transfer and this intent, and the
  // adapter refuses a payload carrying anyone else's. `requirements.memo`
  // repeats `depositId` precisely so a client never has to know that; asserting
  // it is how this run notices if it ever stops being true.
  if (requirements.memo !== created.depositId) {
    throw new Error(
      `requirements.memo is "${requirements.memo}" but the intent is ${created.depositId} — ` +
        `the memo IS the deposit id, and a transfer carrying anything else is refused before ` +
        `it reaches the facilitator`,
    );
  }
  // Not cosmetic: this scale goes into `TransferChecked`, which the token
  // program checks against the mint and rejects on a mismatch. It also has to
  // agree with the scale this run's funding was minted at.
  if (requirements.decimals !== DEVNET_TOKEN_DECIMALS) {
    throw new Error(
      `the deposit asset is quoted at ${requirements.decimals} decimals but this run funded the ` +
        `buyer on a mint of ${DEVNET_TOKEN_DECIMALS} — TransferChecked would be refused by the ` +
        `token program, and the two scales cannot both be right`,
    );
  }
  // `lastValidBlockHeight` is in here for a reason the other three are not:
  // it is the one field whose empty value is *silent*. `BigInt('')` is `0n`,
  // not a throw, so an absent height would compile into a lifetime of zero
  // rather than failing — and it would do so invisibly, since the height is
  // not part of the compiled message and nothing downstream reads it back.
  if (
    !requirements.blockhash ||
    !requirements.lastValidBlockHeight ||
    !requirements.feePayer ||
    !requirements.payTo
  ) {
    throw new Error(
      `POST /deposits answered without something the transfer cannot be built from: ` +
        `blockhash=${requirements.blockhash || '(empty)'} ` +
        `lastValidBlockHeight=${requirements.lastValidBlockHeight || '(empty)'} ` +
        `feePayer=${requirements.feePayer || '(empty)'} payTo=${requirements.payTo || '(empty)'}`,
    );
  }

  // ── build + sign ──────────────────────────────────────────────────────────
  // A PDA derivation, not a lookup — no RPC round trip inside the window. The
  // mint is the server's own answer rather than this script's `.env`, so a
  // deployment pointed at a different `SOLANA_DEVNET_USDC_MINT` fails as an
  // unfunded token account (named in the diagnostic) instead of transferring
  // from an account that is not the one the vault is measuring.
  const mint = address(requirements.asset);
  const [buyerAta] = await findAssociatedTokenPda({
    owner: signer.address,
    mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  const payload = await buildDepositPayload({
    // The server's blockhash, never a freshly fetched one — see `DepositLifetime`.
    lifetime: {
      blockhash: requirements.blockhash,
      lastValidBlockHeight: BigInt(requirements.lastValidBlockHeight),
    },
    userSigner: signer,
    userAta: buyerAta,
    vaultAta: address(requirements.payTo),
    mint,
    decimals: requirements.decimals,
    // The server's echo, having just been asserted equal to what was asked for.
    amountAtomic: BigInt(requirements.amount),
    feePayer: address(requirements.feePayer),
    memo: requirements.memo,
  });

  // ── settle ────────────────────────────────────────────────────────────────
  const settlePath = `/api/v1/deposits/${created.depositId}/settle`;
  let settled: SettledDepositDto;
  // This answers 201, not 200 — Nest's default for `@Post`, and deliberate.
  // `createApiClient` treats every 2xx alike, so nothing here depends on which,
  // and nothing should "fix" the route to 200 on this script's account.
  try {
    settled = await api.post<SettledDepositDto>(settlePath, {
      x402Version: X402_VERSION,
      scheme: SOLANA_PAYMENT_SCHEME,
      network: SOLANA_DEVNET,
      payload: { transaction: payload.transactionBase64 },
    } satisfies SettleDepositBodyDto);
  } catch (error) {
    // Rethrown, always — `step()` owns the FAILED record and a step that
    // swallowed its own error would produce a green run with a silent report.
    throw await explainDepositSettleFailure(
      ctx,
      settlePath,
      requirements,
      buyerAta,
      Date.now() - startedAt,
      error,
    );
  }
  const elapsedMs = Date.now() - startedAt;

  if (settled.id !== created.depositId) {
    throw new Error(
      `settled deposit ${settled.id} is not the intent that was created (${created.depositId})`,
    );
  }
  if (settled.status !== DepositIntentStatus.SETTLED) {
    throw new Error(
      `deposit ${created.depositId} came back ${settled.status}, expected ` +
        `${DepositIntentStatus.SETTLED} (tx=${settled.chainTxRef ?? 'none'})`,
    );
  }
  if (!settled.chainTxRef) {
    throw new Error(
      `deposit ${created.depositId} is ${settled.status} with no chainTxRef — the schema pairs ` +
        `those two columns as one fact, so this is a settlement that names no transaction`,
    );
  }
  if (!settled.settledAmount) {
    throw new Error(
      `deposit ${created.depositId} is ${settled.status} with no settledAmount, on ` +
        `${settled.chainTxRef}`,
    );
  }
  if (settled.settledAmount.amount !== BUYER_DEPOSIT_AMOUNT_MINOR) {
    throw new Error(
      `the chain was observed to move ${settled.settledAmount.amount} into the vault on ` +
        `${settled.chainTxRef}, but ${BUYER_DEPOSIT_AMOUNT_MINOR} was requested and signed for. ` +
        `settledAmount is the vault's own token-balance delta, not an echo of the request — so a ` +
        `difference means the transfer that landed is not the transfer this run built`,
    );
  }
  const expectedAsset = toAssetId(SOLANA_DEVNET, 'token', requirements.asset);
  if (settled.settledAmount.asset !== expectedAsset) {
    throw new Error(
      `the deposit credited ${settled.settledAmount.asset} but the transfer moved ` +
        `${requirements.asset} (${expectedAsset})`,
    );
  }
  if (settled.settledAmount.decimals !== requirements.decimals) {
    throw new Error(
      `the deposit credited ${settled.settledAmount.asset} at ` +
        `${settled.settledAmount.decimals} decimals, but the transfer was signed at ` +
        `${requirements.decimals} — one asset at two scales is data corruption`,
    );
  }

  // ── spendable, not merely settled ─────────────────────────────────────────
  // The step is not done until the money can be held against — see
  // `awaitDepositCredited` for why `SETTLED` is not that, and for the wait.
  const credited = await awaitDepositCredited(api, toMoney(settled.settledAmount));

  return (
    `deposit=${settled.id} status=${settled.status} ` +
    `settled=${MoneyUtil.format(toMoney(settled.settledAmount))} tx=${settled.chainTxRef} ` +
    `buyer=${signer.address} ata=${buyerAta} vaultAta=${requirements.payTo} ` +
    `feePayer=${requirements.feePayer} (buyer signed as owner only; the facilitator co-signed ` +
    `and paid the gas) memo=${requirements.memo} blockhash=${requirements.blockhash} ` +
    `create->settle in ${elapsedMs}ms, against a ~${BLOCKHASH_WINDOW_MS / 1000}s devnet ` +
    `blockhash window and a ` +
    `${DEPOSIT_INTENT_TTL_MS}ms intent TTL; expiresAt=${created.expiresAt}; ` +
    // The split is printed, not just the total: `available` is what a hold can
    // be taken against and `pending` is what cannot, and a reader of a green
    // report should be able to see which is which without opening this file.
    `then SPENDABLE — available=${MoneyUtil.format(toMoney(credited.balance.available))} ` +
    `pending=${MoneyUtil.format(toMoney(credited.balance.pending))} ` +
    `held=${MoneyUtil.format(toMoney(credited.balance.held))} ` +
    `(DEPOSIT_PENDING -> DEPOSIT_CONFIRM by the scheduler's ` +
    `"${DEPOSIT_FINALITY_SWEEP_CRON}" finality sweep, seen after ${credited.attempts} read(s) ` +
    `over ${credited.waitedMs}ms)`
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Steps 6 and 7 — the MCP surface
// ───────────────────────────────────────────────────────────────────────────

/**
 * One organization's position in one asset, as four comparable `Money` values.
 *
 * ## Why this is not {@link ledgerFingerprint}
 *
 * That helper answers a different question and answers it deliberately opaquely:
 * *did anything at all move*, by string equality over the whole payload. Step 3
 * needs exactly that, because "the tester charges nobody" is an equality claim
 * about an organization with no balance rows at all.
 *
 * Step 7's claim is arithmetic — *`available` fell by exactly this many atomic
 * units* — and a fingerprint cannot express it. Forcing one helper to do both
 * would mean either weakening step 3's comparison to a few named buckets or
 * parsing numbers back out of a string that exists to be compared as a string.
 *
 * ## Why exactly one row is required
 *
 * `AccountBalanceDto` carries **no account id** (see {@link awaitDepositCredited},
 * which refuses the same way for the same reason). One organization holds one
 * row per `(account, asset)` pair, so two rows in one asset would make every
 * subtraction below ambiguous about whose money moved. A fresh buyer
 * organization has exactly one ledger account, and this run made exactly one
 * deposit into it, so two rows is a fact worth failing on rather than summing.
 */
interface AssetPosition {
  readonly available: Money;
  readonly held: Money;
  readonly pending: Money;
  readonly total: Money;
}

/**
 * @param options.fresh bust {@link HTTP_GET_CACHE_TTL_MS} on this read. Off by
 *   default because step 7's before/after pair is already separated by a
 *   convergence loop longer than the TTL, and a suite that busted the cache on
 *   every read would stop exercising the cache a real client gets. Step 8b's
 *   pair can be as little as a few seconds apart when a case executes the
 *   moment `--resume` starts, so it asks for it.
 */
async function readAssetPosition(
  api: ReturnType<typeof createApiClient>,
  asset: AssetId,
  options: { readonly fresh?: boolean } = {},
): Promise<AssetPosition> {
  const path = '/api/v1/balances';
  const snapshot = await api.get<GetBalancesResponseDto>(options.fresh ? uncacheable(path) : path);
  const rows = snapshot.balances.filter((row) => row.asset === asset);

  if (rows.length !== 1) {
    throw new Error(
      `expected exactly one ${asset} balance row for this organization and found ${rows.length}. ` +
        `AccountBalanceDto carries no account id, so with ${rows.length === 0 ? 'none' : 'more than one'} ` +
        `there is no way to say which account a movement belongs to. ` +
        `Rows on offer: [${snapshot.balances.map((row) => row.asset).join(', ')}]`,
    );
  }

  const [row] = rows;
  return {
    available: toMoney(row.available),
    held: toMoney(row.held),
    pending: toMoney(row.pending),
    total: toMoney(row.total),
  };
}

function formatPosition(position: AssetPosition): string {
  return (
    `available=${MoneyUtil.format(position.available)} ` +
    `held=${MoneyUtil.format(position.held)} ` +
    `pending=${MoneyUtil.format(position.pending)} ` +
    `total=${MoneyUtil.format(position.total)}`
  );
}

/**
 * An MCP client connected as one bearer token, over the transport a real agent
 * host uses.
 *
 * The reference `Client` over `StreamableHTTPClientTransport`, exactly as
 * `scripts/mcp/session.ts` does it — and that file is deliberately **not**
 * imported: it ends in a top-level `void main()`, so importing it would run a
 * whole demo session as a side effect of loading this one. `scripts/mcp/demo-config.ts`
 * is not imported either; it reads the demo credentials file at module load and
 * would throw on a machine that has never run `yarn demo:seed`, taking the
 * acceptance suite down over a file it does not use.
 *
 * What the SDK buys is not convenience. It validates every response against the
 * specification's schemas and **discards what it does not recognise**, which is
 * the exact behaviour that decides whether the price this platform publishes
 * reaches an agent at all. A hand-rolled `fetch` would show a catalogue no real
 * client would ever see. See the file header.
 */
async function connectMcp(token: string): Promise<Client> {
  const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcpUrl()), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

/** The shape `x402/price` carries: atomic units, the asset, and a display form. */
interface McpPriceValue {
  readonly amount?: unknown;
  readonly asset?: unknown;
  readonly display?: unknown;
}

/**
 * Step 6 (MCP server): the buyer mints its **own** MCP credential
 * and asks the catalogue what a call costs.
 *
 * ## Why a second credential and not the one the run already holds
 *
 * `mintScriptIdentity` wrote a credential row straight into Postgres so that
 * steps 1–5 could authenticate at all. That is scaffolding — it never went
 * through a controller, a guard or a DTO. Step 6 is a distinct product
 * action ("the buyer mints their own credential"), and the only way to exercise it is
 * `POST /agents/:agentId/credentials` on the live server, whose response carries
 * the secret **exactly once** and is the only place it will ever be
 * visible. The list read afterwards is what turns "a token came back" into "a
 * second credential exists under this agent": two rows where the mint left one.
 *
 * ## What is asserted about the catalogue, and what cannot be
 *
 * The load-bearing assertion is that the tool this run published is **listed
 * with a price**. `McpCatalogueService` omits a tool with no routable supply
 * rather than listing it unpriced — *"an unpriced entry in a price-annotated
 * catalogue reads as free to a model skimming the list"* — so a missing entry
 * here would mean step 4's publish did not survive into routable supply.
 *
 * The price is read from **`_meta`**, not `annotations`. Both are published with
 * identical values (`describe()` does `_meta: { ...annotations }`), and the SDK
 * strips the `annotations` copy on the way in. Which channel actually carried it
 * is recorded in the report rather than assumed, because a change in either
 * direction is invisible from any other vantage point.
 *
 * What is **not** asserted is that the quoted price is this run's binding price.
 * A catalogue tool is shared supply: `quote()` returns the dearest eligible
 * binding across every provider behind the tool, and each completed run of this
 * suite adds another `ACTIVE` binding to the same tool. What *is* asserted is
 * `quoted >= this run's price` — the dearest of a set that contains this run's
 * binding cannot be cheaper than it — so a quote below it means this run's
 * binding is not in the eligible set at all, which would make step 4's publish
 * a publish into nothing.
 */
async function runStep6(ctx: SuiteContext): Promise<string> {
  const { api, agentId } = ctx.buyer;
  if (!ctx.binding) {
    throw new Error('step 6 needs step 3’s binding, and ctx.binding is unset');
  }
  const ourPrice = toMoney(ctx.binding.price);

  const credential = await api.post<CreateAgentCredentialResponseDto>(
    `/api/v1/agents/${agentId}/credentials`,
    { name: 'devnet-acceptance-mcp' } satisfies CreateAgentCredentialBodyDto,
  );

  if (!credential.token) {
    throw new Error(
      `POST /agents/${agentId}/credentials answered with no token. The secret is returned ` +
        `exactly once and there is no endpoint that can show it again, so a response ` +
        `without it is a credential nobody can ever use`,
    );
  }
  if (credential.agentId !== agentId) {
    throw new Error(
      `the credential came back bound to agent ${credential.agentId}, not to the buyer's agent ` +
        `(${agentId})`,
    );
  }
  // `prefix` is stored in clear for disambiguation and must be the leading
  // characters of the secret it disambiguates. A prefix that does not match
  // would make the credential list point at the wrong row on the one screen an
  // operator uses to revoke one.
  if (!credential.token.startsWith(credential.prefix)) {
    throw new Error(
      `the stored prefix "${credential.prefix}" is not the start of the secret this call ` +
        `returned — the list view would then name a different credential than the one revoked`,
    );
  }

  // Two rows: `mintScriptIdentity`'s, and the one just minted over HTTP. This
  // is what makes "the buyer minted its own credential" a fact about the
  // database rather than about a response body.
  const listed = await api.get<{ items: AgentCredentialDto[] }>(
    `/api/v1/agents/${agentId}/credentials`,
  );
  if (!listed.items.some((item) => item.id === credential.id)) {
    throw new Error(
      `credential ${credential.id} was created but does not appear in ` +
        `GET /agents/${agentId}/credentials — the list holds ` +
        `[${listed.items.map((item) => item.id).join(', ')}]`,
    );
  }
  if (listed.items.length < 2) {
    throw new Error(
      `the buyer's agent holds ${listed.items.length} credential(s). The identity mint wrote ` +
        `one directly into Postgres and this step minted a second over HTTP, so anything less ` +
        `than two means one of the two is not there`,
    );
  }

  const client = await connectMcp(credential.token);
  let quoted: Money;
  let toolName: string;
  let priceChannel: string;
  let priceDisplay: string;
  let listedCount: number;
  try {
    const catalogue = await client.listTools();
    listedCount = catalogue.tools.length;

    // Joined on the platform's own uuid rather than on a name. `x402/toolId`
    // exists for exactly this — an MCP tool is addressed by `name` while every
    // receipt, intent and journal entry references the uuid — and matching on
    // the id is what makes this immune to a catalogue rename between steps.
    const descriptors = catalogue.tools.filter(
      (tool) =>
        (tool._meta as Record<string, unknown> | undefined)?.[X402_TOOL_ID] === ACCEPTANCE_TOOL_ID,
    );
    if (descriptors.length === 0) {
      throw new Error(
        `tools/list does not carry the tool this run published (${ACCEPTANCE_TOOL_ID}). ` +
          `McpCatalogueService OMITS a tool with no routable supply rather than listing it ` +
          `unpriced, so this means binding ${ctx.binding.id} is ACTIVE (step 4 proved it) and ` +
          `still not routable — check the stake gate and the binding ceilings. ` +
          `Listed: [${catalogue.tools.map((tool) => tool.name).join(', ')}]`,
      );
    }
    if (descriptors.length > 1) {
      throw new Error(
        `tools/list carries ${descriptors.length} entries for tool ${ACCEPTANCE_TOOL_ID} ` +
          `([${descriptors.map((tool) => tool.name).join(', ')}]) — one uuid is one tool, and a ` +
          `duplicate makes every price below a coin flip`,
      );
    }
    const [descriptor] = descriptors;
    toolName = descriptor.name;

    const fromMeta = (descriptor._meta as Record<string, unknown> | undefined)?.[X402_PRICE] as
      | McpPriceValue
      | undefined;
    const fromAnnotations = (descriptor.annotations as Record<string, unknown> | undefined)?.[
      X402_PRICE
    ] as McpPriceValue | undefined;

    if (!fromMeta) {
      throw new Error(
        `${toolName} is listed without ${X402_PRICE} in _meta` +
          `${fromAnnotations ? ' (it IS in annotations)' : ' and not in annotations either'}. ` +
          `_meta is the copy an SDK client receives: the MCP specification types annotations as ` +
          `a closed set and the reference SDK STRIPS every key it does not know, which is why ` +
          `mcp.constants.ts publishes both. A tool listed without a price is worse than one not ` +
          `listed at all — the agent calls it anyway and finds out afterwards. ` +
          `_meta held [${Object.keys((descriptor._meta as Record<string, unknown>) ?? {}).join(', ')}]`,
      );
    }
    priceChannel = fromAnnotations
      ? 'both annotations and _meta'
      : '_meta only (annotations stripped by the SDK, as expected)';

    if (typeof fromMeta.amount !== 'string' || typeof fromMeta.asset !== 'string') {
      throw new Error(
        `${X402_PRICE} on ${toolName} is ${JSON.stringify(fromMeta)} — amount and asset must ` +
          `both be strings; money is never a number on this wire`,
      );
    }
    if (fromMeta.asset !== ourPrice.asset) {
      throw new Error(
        `${toolName} is quoted in ${fromMeta.asset} and binding ${ctx.binding.id} is priced in ` +
          `${ourPrice.asset}. dearestPrice() refuses a tool whose bindings disagree on the asset, ` +
          `so this is the catalogue and this run naming two different settlement assets`,
      );
    }
    // The scale is the asset registry's on both sides — `dearestPrice` takes it
    // from `getAssetMetadata`, and `binding.price.decimals` reached this script
    // through the same registry — which is what licenses reusing it here rather
    // than inventing one. The asset equality just above is the check that makes
    // that true.
    quoted = MoneyUtil.of(fromMeta.amount, ourPrice.asset, ourPrice.decimals);
    // The trimmed, human form the catalogue publishes beside the atomic figure
    // ("$0.08"). Reported, not asserted: `displayPrice` trims trailing zeros for
    // a model reading a list, and `amount` beside it is what is actually
    // charged — step 7 asserts against that one.
    priceDisplay = typeof fromMeta.display === 'string' ? fromMeta.display : '(none)';

    if (MoneyUtil.lessThan(quoted, ourPrice)) {
      throw new Error(
        `the catalogue quotes ${MoneyUtil.format(quoted)} for ${toolName} while this run's ` +
          `binding ${ctx.binding.id} is published at ${MoneyUtil.format(ourPrice)}. The quote is ` +
          `the DEAREST eligible binding, so a quote below this run's price means this run's ` +
          `binding is not in the eligible set — step 4 published it into nothing`,
      );
    }
  } finally {
    // Closed in a `finally` so a failed assertion does not leave a live
    // transport, and a session on the server, behind it.
    await client.close().catch(() => undefined);
  }

  ctx.mcp = {
    token: credential.token,
    credentialId: credential.id,
    toolName,
    quoted,
    priceChannel,
  };

  return (
    `credential=${credential.id} (prefix ${credential.prefix}, expiresAt=` +
    `${credential.expiresAt ? new Date(credential.expiresAt).toISOString() : 'never'}) minted over ` +
    `HTTP; the agent now holds ${listed.items.length} credential(s), the first being the ` +
    `identity mint's; MCP at ${mcpUrl()} listed ${listedCount} tool(s) and ` +
    `${toolName} (${ACCEPTANCE_TOOL_ID}) carries ${X402_PRICE}=${MoneyUtil.format(quoted)} ` +
    `(displayed as "${priceDisplay}") via ${priceChannel}; ` +
    `this run's own binding ${ctx.binding.id} is published at ${MoneyUtil.format(ourPrice)}` +
    `${MoneyUtil.equals(quoted, ourPrice) ? ' — the same figure, so this run IS the dearest eligible binding' : ' — a DIFFERENT, dearer binding is setting the quote; the tool is shared supply'}`
  );
}

/**
 * How long step 7 waits for the asynchronous verification worker to reach a
 * verdict and close the hold.
 *
 * Not a chain wait and not a cron: `McpToolCallService` ends the call at
 * `VERIFYING` and hands the record to `VerificationSettlementService`'s BullMQ
 * worker, which runs the two unsampled stages in milliseconds. The whole budget
 * exists for the queue hop and for the case where no worker is running at all —
 * which the timeout message names, because that is the only way this can spend
 * the full window.
 */
const VERIFICATION_SETTLE_TIMEOUT_MS = 60_000;
const VERIFICATION_SETTLE_POLL_MS = 2_000;

/**
 * **Every `GET` on this API is cached for ten seconds, by default, for every
 * caller** — and step 7 exists on the wrong side of that.
 *
 * `HttpCacheInterceptor` is registered globally in `bootstrap/api/main.ts`. Its
 * "is caching enabled for this handler" gate is **commented out** in the source,
 * so `@HttpCacheTTL` only *changes* a TTL rather than opting in, and a route with
 * no cache decorator at all — `GET /balances`, `GET /receipts/:intentId` —
 * silently gets `defaultTTLSeconds = 10`. The key folds in the caller's
 * organization (that fold is the fix for an earlier cross-tenant cache leak), so
 * this is not a correctness
 * problem; it is a *freshness* one, and it lands squarely on a step that reads a
 * balance, moves money, and reads it again a second later.
 *
 * This was found by running it: step 7's first live run failed asserting that
 * `available` had fallen, with before and after **byte-identical**, while the
 * `account_balances` row had in fact already moved. The `before` read is what
 * populates the cache entry that the `after` read then hits. So a single read
 * after the call cannot see the hold, no matter how long the ledger took —
 * which is why the reads below converge instead. **This is not ledger lag.**
 *
 * Two-and-a-half TTLs, because a poll is only evidence if it outlives the thing
 * it is polling past.
 */
const HTTP_GET_CACHE_TTL_MS = 10_000;
const LEDGER_VISIBILITY_TIMEOUT_MS = HTTP_GET_CACHE_TTL_MS * 2.5;

/** Which of the two shapes a charged call's ledger is in. */
type ChargeShape = 'HOLD_OPEN' | 'HOLD_COMMITTED';

/**
 * Waits for the charge to become **visible**, and says which of the two shapes
 * it is in.
 *
 * The one invariant asserted on every read is the one that is true in both
 * shapes and false for everything else:
 *
 * ```text
 *   HOLD_CREATE   available −p   held +p   total  0    the call took the money out of reach
 *   HOLD_COMMIT   available  0   held −p   total −p    the value left the account
 * ```
 *
 * `available` is down by exactly `p` from the moment the hold opens and stays
 * there through the commit; `total` — `available + held + pending` — does not
 * move on a hold at all and falls only when it commits. A check written against
 * `total` alone would therefore pass against a call that took **no hold**, which
 * is the one thing it exists to catch, and a check written against `held` alone
 * would fail the moment the worker won the race. Both buckets are asserted, as a
 * pair, in the two combinations a paid call can actually produce.
 *
 * A `HOLD_RELEASE` (the refund path) puts `available` back, so it never matches
 * and is reported as its own diagnosis rather than waited out.
 */
async function awaitChargeVisible(
  api: ReturnType<typeof createApiClient>,
  before: AssetPosition,
  charged: Money,
): Promise<{ position: AssetPosition; shape: ChargeShape; attempts: number; waitedMs: number }> {
  const startedAt = Date.now();
  const expectedAvailable = MoneyUtil.subtract(before.available, charged);
  const heldIfOpen = MoneyUtil.add(before.held, charged);
  const totalIfCommitted = MoneyUtil.subtract(before.total, charged);
  let attempts = 0;
  let last = before;

  for (;;) {
    attempts += 1;
    last = await readAssetPosition(api, charged.asset);

    if (MoneyUtil.equals(last.available, expectedAvailable)) {
      if (MoneyUtil.equals(last.held, heldIfOpen) && MoneyUtil.equals(last.total, before.total)) {
        return { position: last, shape: 'HOLD_OPEN', attempts, waitedMs: Date.now() - startedAt };
      }
      if (
        MoneyUtil.equals(last.held, before.held) &&
        MoneyUtil.equals(last.total, totalIfCommitted)
      ) {
        return {
          position: last,
          shape: 'HOLD_COMMITTED',
          attempts,
          waitedMs: Date.now() - startedAt,
        };
      }
      // `available` moved by the right amount and the other two buckets are in
      // neither shape. Waiting cannot turn that into one of them.
      throw new Error(
        `'available' fell by exactly ${MoneyUtil.format(charged)} but the other two buckets are ` +
          `in neither state a paid call can produce. An open hold would be held=` +
          `${MoneyUtil.format(heldIfOpen)} total=${MoneyUtil.format(before.total)}; a committed ` +
          `one would be held=${MoneyUtil.format(before.held)} total=` +
          `${MoneyUtil.format(totalIfCommitted)}. ` +
          `before: ${formatPosition(before)} | read: ${formatPosition(last)}`,
      );
    }

    if (Date.now() - startedAt >= LEDGER_VISIBILITY_TIMEOUT_MS) {
      throw new Error(
        `the call was charged ${MoneyUtil.format(charged)} and 'available' never moved: after ` +
          `${attempts} read(s) over ${Date.now() - startedAt}ms it is still ` +
          `${MoneyUtil.format(last.available)}, and ${MoneyUtil.format(expectedAvailable)} was ` +
          `expected. HOLD_CREATE is { available: -1, held: +1 } and is written THROUGH, inside the request tools/call already awaited, so this ` +
          `is not the ledger being slow. The reads above already outlast the ` +
          `${HTTP_GET_CACHE_TTL_MS / 1000}s default HTTP GET cache, so it is not that either. ` +
          `before: ${formatPosition(before)} | last read: ${formatPosition(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFICATION_SETTLE_POLL_MS));
  }
}

/**
 * Waits for the hold to be **committed**, and reports honestly when it never is.
 *
 * ## Why this is not `awaitChargeVisible` called a second time
 *
 * That function returns on the first read matching *either* shape, and by the
 * time this runs there is a `GET /balances` cache entry — populated by that very
 * poll — holding the `HOLD_OPEN` shape for up to
 * {@link HTTP_GET_CACHE_TTL_MS}. So a second call to it would return `HOLD_OPEN`
 * from cache, immediately, and the caller would print `HOLD NOT COMMITTED` no
 * matter what the ledger said.
 *
 * That is harmless while the rail-A defect stands, because the answer is
 * `HOLD_OPEN` either way. It stops being harmless **the day the defect is
 * fixed**: the one line that would tell somebody the fix worked would be the one
 * line still reporting it broken. A false negative on the success signal is
 * worse than no signal, so this waits for the affirmative shape only.
 *
 * ## What makes a `false` here trustworthy
 *
 * The window is {@link LEDGER_VISIBILITY_TIMEOUT_MS} — `2.5 ×` the cache TTL —
 * so a `committed: false` cannot be a stale entry that simply had not expired:
 * by the deadline, this has read a fresh answer for at least one and a half
 * TTLs. That relationship is the whole reason the two constants are derived from
 * each other rather than picked independently. **If the TTL ever rises above
 * this window, this function silently starts lying**, which is why it says so
 * here and asserts nothing it cannot see.
 *
 * `available` is re-checked on every read for the same reason it is checked
 * before the verdict: a `HOLD_RELEASE` would put it back, and money returning to
 * a buyer whose intent is `SETTLED` is a contradiction to fail on rather than to
 * summarise.
 */
async function awaitHoldCommitted(
  api: ReturnType<typeof createApiClient>,
  before: AssetPosition,
  charged: Money,
): Promise<{ position: AssetPosition; committed: boolean; attempts: number; waitedMs: number }> {
  const startedAt = Date.now();
  const expectedAvailable = MoneyUtil.subtract(before.available, charged);
  const totalIfCommitted = MoneyUtil.subtract(before.total, charged);
  let attempts = 0;
  let last = before;

  for (;;) {
    attempts += 1;
    last = await readAssetPosition(api, charged.asset);

    if (!MoneyUtil.equals(last.available, expectedAvailable)) {
      throw new Error(
        `the intent is SETTLED but 'available' is ${MoneyUtil.format(last.available)} rather ` +
          `than ${MoneyUtil.format(expectedAvailable)} — the charge came back. A settled call ` +
          `whose money returned to the buyer is a contradiction, not a state to wait out. ` +
          `before: ${formatPosition(before)} | read: ${formatPosition(last)}`,
      );
    }
    if (
      MoneyUtil.equals(last.held, before.held) &&
      MoneyUtil.equals(last.total, totalIfCommitted)
    ) {
      return { position: last, committed: true, attempts, waitedMs: Date.now() - startedAt };
    }

    if (Date.now() - startedAt >= LEDGER_VISIBILITY_TIMEOUT_MS) {
      // Not a failure — the caller reports it. See `runStep7`'s doc comment for
      // why this is reported rather than asserted.
      return { position: last, committed: false, attempts, waitedMs: Date.now() - startedAt };
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFICATION_SETTLE_POLL_MS));
  }
}

/**
 * Waits for the asynchronous verification worker to reach a verdict, and returns
 * the receipt that carries it.
 *
 * `McpToolCallService` ends a paid call at `VERIFYING` and hands the record to
 * `VerificationSettlementService`'s BullMQ worker; there is no route and no cron
 * that judges it, so a run with no worker process waits here and the timeout
 * says so by name. `REFUNDED` is a real outcome for a bad response and therefore
 * a step-7 failure — this step's whole subject is a *good* call being charged
 * for — so it is diagnosed with the verdict rather than waited out, and any
 * other terminal status fails on the first read that sees it.
 */
async function awaitVerdict(
  api: ReturnType<typeof createApiClient>,
  intentId: string,
): Promise<{ receipt: GetReceiptResponseDto; attempts: number; waitedMs: number }> {
  const startedAt = Date.now();
  let attempts = 0;
  let lastStatus = '(no read completed)';

  for (;;) {
    attempts += 1;
    const receipt = await api.get<GetReceiptResponseDto>(`/api/v1/receipts/${intentId}`);
    lastStatus = receipt.status;

    if (receipt.status === PaymentIntentStatus.SETTLED) {
      return { receipt, attempts, waitedMs: Date.now() - startedAt };
    }
    if (receipt.status === PaymentIntentStatus.REFUNDED) {
      throw new Error(
        `intent ${intentId} was REFUNDED, not SETTLED. The buyer got its money back, which means ` +
          `the platform judged this provider's response as not honouring the tool contract — a ` +
          `real outcome, and a failure of step 7, whose subject is a GOOD call being charged ` +
          `for. Verdict: ${receipt.verdict.status ?? '(none)'} ` +
          `(${receipt.verdict.reasonCode ?? 'no code'}: ${receipt.verdict.reason ?? 'no reason'}). ` +
          `Stages: ${describeStages(receipt.stages)}`,
      );
    }
    if (isTerminalPaymentIntentStatus(receipt.status as PaymentIntentStatus)) {
      throw new Error(
        `intent ${intentId} is ${receipt.status}: terminal, and neither SETTLED nor REFUNDED. A ` +
          `DATA_RESULT that reached VERIFYING has exactly those two exits. ` +
          `Stages: ${describeStages(receipt.stages)}`,
      );
    }

    if (Date.now() - startedAt >= VERIFICATION_SETTLE_TIMEOUT_MS) {
      throw new Error(
        `the call was charged and never judged: after ${attempts} read(s) over ` +
          `${Date.now() - startedAt}ms the intent is still ${lastStatus}. McpToolCallService ends ` +
          `a paid call at VERIFYING and hands it to VerificationSettlementService's BullMQ worker ` +
          `— there is no HTTP route and no cron that judges it. So the likeliest cause is that no ` +
          `WORKER is running: start one (SERVICE_TYPE=worker, or SERVICE_TYPE=all, which boots it ` +
          `beside the API, the scheduler and the MCP server). The hold stays open until its own ` +
          `24-hour expiry either way, so the buyer's money is reserved rather than lost. ` +
          `Reads on this route also pass through the ${HTTP_GET_CACHE_TTL_MS / 1000}s default ` +
          `HTTP GET cache, which the window above already outlasts many times over.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFICATION_SETTLE_POLL_MS));
  }
}

/** Every stage as one line — used only inside failure messages. */
function describeStages(stages: readonly ReceiptStageDto[]): string {
  return stages
    .map(
      (stage) =>
        `${stage.stage}=${stage.status}${stage.code ? `(${stage.code})` : ''}` +
        `${stage.detail ? ` [${stage.detail}]` : ''}`,
    )
    .join(' ');
}

/**
 * Step 7 (MCP call, verification worker, receipt): one real paid tool call,
 * through the MCP protocol, charged against real ledger money.
 *
 * ```text
 *   tools/call            -> DATA_RESULT + _meta[x402/receipt], intent VERIFYING
 *   GET /balances         -> available DOWN by the quote, held UP by it, total UNCHANGED
 *   worker judges         -> intent SETTLED, hold committed
 *   GET /receipts/:id     -> all four verification stages, chargedPrice == the quote
 *   GET /balances         -> available still down by the quote, held back, total DOWN by it
 * ```
 *
 * ## The balance assertion, and why `total` alone could not make it
 *
 * A paid call does not debit an account — it takes a **hold**. `HOLD_CREATE` is
 * `{ available: −1, held: +1, pending: 0 }` (`ledger-entry-effect.ts`), and
 * `total` is defined as `available + held + pending`, so the sum does not move
 * at all until the hold commits. A check written against `total` immediately
 * after the call would pass against a call that took no hold, which is the one
 * thing it exists to catch. Step 3's fingerprint learned the same lesson from
 * the other end.
 *
 * So the movement is asserted per bucket, in the two combinations a paid call
 * can produce — see {@link awaitChargeVisible}, which owns that arithmetic.
 *
 * It is a **poll**, and it is one because a live run proved a single read could
 * not work: every `GET` on this API is served from a ten-second cache by default
 * (`HTTP_GET_CACHE_TTL_MS`), and this step's own `before` read is what populates
 * the entry the `after` read then hits. That is a property of the API surface, on
 * the route a wallet screen reads too — not ledger lag, and not something to be
 * tuned away.
 *
 * ## What is charged is the QUOTE, and that is the assertion
 *
 * The agent is held for, and charged, `quote.price` — the dearest eligible
 * binding — not the price of whichever binding ends up serving. That is the
 * router's stated contract: *"the agent is quoted the worst case, is held for
 * the worst case, and is never charged more than it agreed to."* Asserting the
 * charge against this run's own binding price would therefore be asserting
 * something the platform does not promise, and would fail on any run where an
 * older binding on the same shared catalogue tool is dearer — which, after the
 * first run of this suite, is most of them.
 *
 * ## Which provider served is REPORTED, never asserted
 *
 * `route()` picks weighted-randomly among every eligible binding, and each
 * completed run of this suite leaves another `ACTIVE` binding on the same tool.
 * So this run's own provider serves roughly one call in N and asserting it would
 * make the suite fail for a reason that is not a defect. The receipt's
 * `providerId` is printed beside this run's own organization id so a reader can
 * see which happened. **This is a real gap in what step 7 proves** — that the
 * money reached *this run's* provider is not shown here.
 *
 * ## "The receipt shows all verification layers"
 *
 * The MCP receipt (`_meta[x402/receipt]`) is the agent's payment document — what
 * it paid, to whom, how far the call got — and deliberately carries no
 * verification detail, because at the moment it is written there is none: the
 * call ends at `VERIFYING`. The four-layer receipt is the platform's, at
 * `GET /api/v1/receipts/:intentId`, and `ReceiptService.buildStages` emits one
 * row per {@link VerificationStage} **always** — a stage the pipeline never
 * reached is `NOT_REACHED`, never omitted, because an omission reads as a tick
 * to anyone scanning a list. Both are asserted: the MCP receipt for the money,
 * the REST receipt for the layers.
 *
 * ## The one thing this step reports as a DEFECT instead of asserting
 *
 * **A rail-A call's hold is never committed, and its provider is never
 * credited.** Found by the first live run of this step and confirmed against the
 * database, so it is stated as fact rather than suspicion:
 *
 * **Two call sites, not one** — worth keeping straight, because collapsing them
 * sends the next reader to the wrong file:
 *
 * ```text
 *   payment_intents.provider_account       written ONLY from a transition's
 *                                          context (payment-intent.service.ts:173)
 *
 *   McpToolCallService.resolveDataResult   PROVIDER_EXECUTING -> VERIFYING.
 *                                          Passes providerId, bindingId,
 *                                          classification, reason — and NO
 *                                          providerAccount. This is where the
 *                                          value goes missing.
 *
 *   VerificationSettlementService          VERIFYING -> SETTLED, in the worker
 *     .transitionIntent (:421)             (a DIFFERENT file and a DIFFERENT
 *                                          process). Its resolve() moves the
 *                                          status, THEN throws
 *                                          PAYMENT_PROVIDER_NOT_ASSIGNED on the
 *                                          `!intent.providerAccount` guard.
 *                                          This is where it BREAKS.
 * ```
 *
 * So the intent ends `SETTLED` with a `PASS` verdict, `hold_released_at` null,
 * the `ledger_holds` row still `OPEN`, and no `HOLD_COMMIT`, `PROVIDER_CREDIT`
 * or `PLATFORM_FEE` written anywhere. `resolve()`'s own doc comment describes
 * this outcome exactly — *"the intent is terminal with its hold still open …
 * the backstop is the hold's own 24-hour expiry, which releases in the agent's
 * favour — the wrong answer for a COMMIT"*.
 *
 * ## Why it survived: two comments guarding a CHECK that does not exist
 *
 * `payment-intent.service.ts:305-307` and
 * `verification-settlement.service.ts:473-475,508` **both** say a database
 * `CHECK` makes a null `provider_account` unreachable on a routed intent. It
 * does not: `1755600000000-routed-payment-intents.ts:63-66` constrains
 * `provider_id` and leaves `provider_account` unconstrained. So the guard that
 * two independent call sites are relying on was never written, and each site's
 * comment made the other look already covered.
 *
 * Measured across the devnet database at the time: **4,879** settled `RAIL_A_PER_CALL` intents,
 * `provider_account` null on all 4,879, `hold_released_at` null on all 4,879.
 * Committed `ledger_holds` by rail: `RAIL_B_VOUCHER` 74, `RAIL_A_PER_CALL` 0.
 *
 * It is **reported, not asserted**, and that is a deliberate call rather than an
 * omission: crediting a provider is not one of this suite's nine steps, fixing it
 * needs a decision about where a provider's ledger account comes from (not this
 * script's call), and a step 7 that failed on it would block
 * steps 8 and 9 from ever running behind a defect they do not depend on. The
 * step detail says `HOLD NOT COMMITTED` in full on every run it happens, so the
 * on-disk report carries it rather than this comment alone.
 */
async function runStep7(ctx: SuiteContext): Promise<string> {
  const { api } = ctx.buyer;
  if (!ctx.mcp) {
    throw new Error('step 7 needs step 6’s MCP credential and quote, and ctx.mcp is unset');
  }
  if (!ctx.binding) {
    throw new Error('step 7 needs step 3’s binding, and ctx.binding is unset');
  }
  const { toolName, quoted } = ctx.mcp;

  const before = await readAssetPosition(api, quoted.asset);
  if (MoneyUtil.lessThan(before.available, quoted)) {
    throw new Error(
      `the buyer holds ${MoneyUtil.format(before.available)} available and the call costs ` +
        `${MoneyUtil.format(quoted)}. A hold is taken out of 'available' and nothing else, so ` +
        `this call would be refused before it reached a provider (${formatPosition(before)})`,
    );
  }

  const client = await connectMcp(ctx.mcp.token);
  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    // No arguments: this tool's `inputSchema.properties` is empty — the same
    // reason step 3 runs the mapping tester with `{}`.
    result = await client.callTool({ name: toolName, arguments: {} });
  } finally {
    await client.close().catch(() => undefined);
  }

  const meta = (result._meta ?? {}) as Record<string, unknown>;
  if (result.isError) {
    throw new Error(
      `tools/call on ${toolName} came back as an error result: ` +
        `${JSON.stringify(meta[X402_RECEIPT] ?? meta)} — ` +
        `${JSON.stringify(result.content)}. Every tool-call failure is reported INSIDE the ` +
        `result rather than as a JSON-RPC error, so this is the server's own verdict on the ` +
        `call, not a transport problem`,
    );
  }

  // ── The receipt the agent is handed ───────────────────────────────────────
  const receipt = meta[X402_RECEIPT] as
    | {
        intentId?: unknown;
        charged?: { amount?: unknown; asset?: unknown; display?: unknown };
        status?: unknown;
        toolId?: unknown;
        providerId?: unknown;
        classification?: unknown;
        attempts?: unknown;
      }
    | undefined;
  if (!receipt) {
    throw new Error(
      `tools/call on ${toolName} succeeded with no ${X402_RECEIPT} in _meta. The receipt is the ` +
        `one document that tells an agent what it just paid, and _meta is the only channel that ` +
        `survives the SDK. _meta held [${Object.keys(meta).join(', ')}]`,
    );
  }
  if (typeof receipt.intentId !== 'string') {
    throw new Error(
      `the receipt names no payment intent (intentId=${JSON.stringify(receipt.intentId)}). ` +
        `Only the free relay path answers null, and this call was quoted ` +
        `${MoneyUtil.format(quoted)} — a paid call with no payment record is money moved with ` +
        `nothing to reconcile it against`,
    );
  }
  const intentId = receipt.intentId;

  if (typeof receipt.charged?.amount !== 'string' || typeof receipt.charged?.asset !== 'string') {
    throw new Error(
      `the receipt's charged amount is ${JSON.stringify(receipt.charged)} — money is never a ` +
        `number on this wire`,
    );
  }
  if (receipt.charged.asset !== quoted.asset) {
    throw new Error(
      `the receipt charges in ${receipt.charged.asset} and ${toolName} was quoted in ` +
        `${quoted.asset}`,
    );
  }
  const charged = MoneyUtil.of(receipt.charged.amount, quoted.asset, quoted.decimals);
  if (!MoneyUtil.equals(charged, quoted)) {
    throw new Error(
      `${toolName} was quoted ${MoneyUtil.format(quoted)} by tools/list and the receipt says ` +
        `${MoneyUtil.format(charged)} was charged. The agent is held for the quote and "is never ` +
        `charged more than it agreed to" — a difference in either direction breaks the one ` +
        `promise the price annotation exists to make`,
    );
  }
  if (receipt.status !== PaymentIntentStatus.VERIFYING) {
    throw new Error(
      `the receipt reports status=${String(receipt.status)}, expected ` +
        `${PaymentIntentStatus.VERIFYING}. A DATA_RESULT that passed the tool's outputSchema is ` +
        `handed to the asynchronous verification worker and has no verdict yet; anything else ` +
        `here means the call took a branch that decided without the worker`,
    );
  }
  if (receipt.classification !== ResponseClass.DATA_RESULT) {
    throw new Error(
      `the receipt classifies the provider's answer as ${String(receipt.classification)}, not ` +
        `${ResponseClass.DATA_RESULT} — only a DATA_RESULT is ever charged for`,
    );
  }
  if (receipt.toolId !== ACCEPTANCE_TOOL_ID) {
    throw new Error(
      `the receipt names tool ${String(receipt.toolId)} and this run called ` +
        `${ACCEPTANCE_TOOL_ID}`,
    );
  }
  if (typeof receipt.providerId !== 'string' || !receipt.providerId) {
    throw new Error(
      `the receipt names no provider (providerId=${JSON.stringify(receipt.providerId)}) for a ` +
        `charged call — it is read back off the payment record, so an absent one means the ` +
        `transition out of PROVIDER_EXECUTING did not write who served`,
    );
  }
  const servedByThisRun = receipt.providerId === ctx.provider.organizationId;

  // ── The data the agent actually asked for ─────────────────────────────────
  // The tool's own contract, which is what the binding's response mapping
  // projects: `{ rate, publishedFor }` — see ACCEPTANCE_RESPONSE_MAPPING.
  const output = result.structuredContent as Record<string, unknown> | undefined;
  if (!output || typeof output !== 'object') {
    throw new Error(
      `tools/call returned no structuredContent. The tool publishes an outputSchema, so an SDK ` +
        `client validates against this field and a result without it is one a real agent would ` +
        `reject: ${JSON.stringify(result.content)}`,
    );
  }
  for (const field of Object.keys(ACCEPTANCE_RESPONSE_MAPPING)) {
    if (!(field in output)) {
      throw new Error(
        `the mapped result is missing "${field}" — ACCEPTANCE_RESPONSE_MAPPING projects ` +
          `[${Object.keys(ACCEPTANCE_RESPONSE_MAPPING).join(', ')}] and the payload is ` +
          `${JSON.stringify(output)}`,
      );
    }
  }

  // ── The charge, converged past the 10s HTTP GET cache ─────────────────────
  const charge = await awaitChargeVisible(api, before, quoted);

  // ── The verdict ───────────────────────────────────────────────────────────
  const judged = await awaitVerdict(api, intentId);
  const rest = judged.receipt;

  if (rest.intentId !== intentId) {
    throw new Error(`GET /receipts/${intentId} answered for intent ${rest.intentId}`);
  }
  // All four layers, in pipeline order, never omitted. The order is
  // asserted as well as the membership: `VERIFICATION_PIPELINE` is the order the
  // engine emits them in and the order a receipt is read in, and a reordered
  // list would put a stage's result under a different stage's heading.
  const stageOrder = rest.stages.map((stage) => stage.stage);
  if (
    stageOrder.length !== VERIFICATION_PIPELINE.length ||
    stageOrder.some((stage, index) => stage !== VERIFICATION_PIPELINE[index])
  ) {
    throw new Error(
      `the receipt carries stages [${stageOrder.join(', ')}] and the pipeline is ` +
        `[${VERIFICATION_PIPELINE.join(', ')}]. All four are emitted always, in this order — a ` +
        `stage that never ran is NOT_REACHED, never absent, because an omission reads as a tick`,
    );
  }
  // The two that run on every call, unsampled. `CROSS_CHECK` and
  // `SEMANTIC` (sampled) are deliberately not required to have passed —
  // neither is guaranteed to have run — but they must be present above, and
  // their status is reported below rather than ignored.
  for (const stage of UNSAMPLED_STAGES) {
    const row = rest.stages.find((entry) => entry.stage === stage);
    if (!row.passed || row.status !== StageStatus.PASSED) {
      throw new Error(
        `${stage} is ${row.status} on a SETTLED call (${row.code ?? 'no code'}: ` +
          `${row.detail ?? 'no detail'}). It runs on every call, unsampled, and a settled call ` +
          `is one the platform vouched for. All stages: ${describeStages(rest.stages)}`,
      );
    }
  }
  if (!rest.verdict.status || !PASSING_VERDICTS.has(rest.verdict.status as VerdictStatus)) {
    throw new Error(
      `the verdict is ${rest.verdict.status ?? '(none)'} on a SETTLED intent — settlement and the ` +
        `verdict must agree, and the passing statuses are ` +
        `[${[...PASSING_VERDICTS].join(', ')}]. ${rest.verdict.reasonCode ?? ''} ` +
        `${rest.verdict.reason ?? ''}`,
    );
  }
  const restCharged = MoneyUtil.of(rest.chargedPrice.amount, quoted.asset, quoted.decimals);
  if (!MoneyUtil.equals(restCharged, quoted)) {
    throw new Error(
      `the receipt says ${MoneyUtil.format(restCharged)} was charged and the agent was ` +
        `quoted ${MoneyUtil.format(quoted)}`,
    );
  }
  const withheld = MoneyUtil.of(rest.withheld.amount, quoted.asset, quoted.decimals);
  if (!MoneyUtil.isZero(withheld)) {
    throw new Error(
      `the receipt withholds ${MoneyUtil.format(withheld)} on a SETTLED call. withheld is ` +
        `listedPrice − chargedPrice, and a settled call is charged its listed price in full`,
    );
  }

  // ── Where the money ended up, once the verdict was in ─────────────────────
  // A COMMITTED-only wait, not a second `awaitChargeVisible`: the poll above has
  // just cached a `HOLD_OPEN` reading, so a call that accepted either shape
  // would report "not committed" from cache even on a run where the rail-A
  // defect had been fixed. See `awaitHoldCommitted`.
  const final = await awaitHoldCommitted(api, before, quoted);
  const committed = final.committed;

  return (
    `${toolName} called over MCP for real: intent=${intentId} charged=` +
    `${MoneyUtil.format(charged)} (exactly what tools/list quoted) classification=` +
    `${String(receipt.classification)} attempts=${String(receipt.attempts)} ` +
    `mapped=${JSON.stringify(output)}; ` +
    // Both ledger states with their figures, so a reader sees the hold rather
    // than inferring it from a `total` that did not move.
    `ledger before: ${formatPosition(before)} | after the call: ` +
    `${formatPosition(charge.position)} (${charge.shape}, seen after ${charge.attempts} read(s) ` +
    `over ${charge.waitedMs}ms — the reads have to outlast the ` +
    `${HTTP_GET_CACHE_TTL_MS / 1000}s default HTTP GET cache, not the ledger) ` +
    `| after the verdict: ${formatPosition(final.position)} ` +
    `(${committed ? 'HOLD_COMMITTED' : 'still HOLD_OPEN'}, after ${final.attempts} read(s) over ` +
    `${final.waitedMs}ms — a window ${LEDGER_VISIBILITY_TIMEOUT_MS / HTTP_GET_CACHE_TTL_MS}x the ` +
    `GET cache TTL, so this is the ledger's answer and not a stale entry); ` +
    `'available' fell by exactly ${MoneyUtil.format(quoted)} and stayed there; ` +
    `intent=${rest.status} verdict=${rest.verdict.status} ` +
    `(${rest.verdict.reasonCode ?? 'no code'}) score=${rest.verdict.score ?? 'none'} ` +
    `sampled=${rest.sampling.sampled ?? 'null'} rate=${rest.sampling.rate ?? 'null'} ` +
    `after ${judged.attempts} read(s) over ${judged.waitedMs}ms; ` +
    `all ${VERIFICATION_PIPELINE.length} layers on the receipt: ${describeStages(rest.stages)}; ` +
    // Reported, never asserted — see the docstring. These are the two things
    // step 7 does NOT prove, and they are spelt out in the report on every run
    // rather than left to whoever reads this file.
    `served by provider ${String(receipt.providerId)} ` +
    `${servedByThisRun ? '— THIS RUN’S OWN provider' : `— NOT this run's provider (${ctx.provider.organizationId}); the tool is shared supply and routing draws weighted-randomly, so which binding serves is not this step's to assert`}` +
    `${
      committed
        ? '; the hold COMMITTED and the provider was credited'
        : `; **HOLD NOT COMMITTED** — the intent is SETTLED with a passing verdict and ` +
          `${MoneyUtil.format(quoted)} is still sitting in 'held'. Two call sites: ` +
          `McpToolCallService.resolveDataResult writes PROVIDER_EXECUTING->VERIFYING without a ` +
          `providerAccount (the only channel that sets the column), and then, in the WORKER, ` +
          `VerificationSettlementService.transitionIntent's resolve(VERIFYING->SETTLED) moves ` +
          `the status and throws PAYMENT_PROVIDER_NOT_ASSIGNED on the guard. Both sites say a ` +
          `database CHECK makes this unreachable; that CHECK constrains provider_id only ` +
          `(1755600000000-routed-payment-intents.ts), so provider_account is unconstrained in ` +
          `every state. No HOLD_COMMIT, no PROVIDER_CREDIT and no PLATFORM_FEE are written, and ` +
          `the hold's 24-hour expiry will eventually release the money back to the BUYER. The ` +
          `buyer is charged correctly and the provider is never paid. Reported rather than ` +
          `asserted deliberately — see this step's doc comment`
    }`
  );
}

/**
 * The verdict statuses that credit the provider and charge the agent.
 *
 * Three, not one: an empty result set is a **passing** answer
 * (`VerdictStatus`'s own comments) — *"a
 * provider whose coverage is narrow and honest must not score worse than one
 * that pads results"* — and it arrives as `EMPTY_CONFIRMED` or
 * `EMPTY_UNVERIFIED` depending on whether a second source was consulted.
 * Asserting `PASS` alone would fail this step on a correct answer.
 */
const PASSING_VERDICTS: ReadonlySet<VerdictStatus> = new Set([
  VerdictStatus.PASS,
  VerdictStatus.EMPTY_CONFIRMED,
  VerdictStatus.EMPTY_UNVERIFIED,
]);

/**
 * Step 0: fail with the one sentence worth reading when the API server is not
 * answering, before anything has been written to Postgres or the chain.
 *
 * Unauthenticated on purpose — `/health` needs no token, and this runs before
 * any identity exists. Without it the first real call throws
 * `TypeError: fetch failed` with the cause buried, which is the single most
 * likely failure of the whole suite. `deposit.ts` names its equivalent
 * condition (an unreachable facilitator) the same way.
 *
 * "Not reachable" and "answered badly" are kept apart deliberately: telling
 * someone to start a server that is already running, because it returned a
 * 500, sends them after the wrong thing entirely.
 */
async function runPreflight(): Promise<string> {
  const api = createApiClient(API_BASE_URL);
  try {
    await api.get('/api/v1/health');
  } catch (cause) {
    if (cause instanceof AcceptanceHttpError) {
      throw new Error(
        `the devnet API server at ${API_BASE_URL} is running but its health check failed ` +
          `(${cause.status}) — it is answering, so this is not a "start the server" problem. ` +
          `${JSON.stringify(cause.body)}`,
      );
    }
    throw new Error(
      `the devnet API server is not reachable at ${API_BASE_URL} — start it, or set ` +
        `ACCEPTANCE_API_BASE_URL. (${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  return `API reachable at ${API_BASE_URL}`;
}

/**
 * Step 0b: refuse to run at all unless this deployment can read a provider's
 * stake off the chain, before a lamport has been spent.
 *
 * Step 4 puts real money into a `ProviderStake` PDA and then asserts that
 * `STAKE_AT_MINIMUM` flipped. If the stake source cannot see the chain, the run
 * fails *after* opening an account and moving `$60`–`$90` into a vault with a
 * twelve-day unbonding period. This is the cheap version of that discovery:
 * one HTTP call, no chain writes.
 *
 * It asks about a **witness** — an organization already staked on the chain
 * with a proved `stake_authority` — because before step 1 there is no provider
 * of this run's own to ask about. `/providers/me/stake` is session-scoped, so
 * {@link borrowOrganizationCredential} mints a credential for the length of
 * this call and deletes it in the `finally`.
 */
async function assertStakeSourceIsChain(app: INestApplicationContext): Promise<string> {
  const organizationId =
    process.env.ACCEPTANCE_STAKED_PROVIDER_ORG_ID ?? CHAIN_STAKED_WITNESS_ORG_ID;

  const credential = await borrowOrganizationCredential(
    app,
    organizationId,
    'stake-source-witness',
  );
  try {
    const witness = createApiClient(API_BASE_URL, credential.token);
    const stake = stakeOnChain(
      await witness.get<GetProviderStakeResponseDto>('/api/v1/providers/me/stake'),
      SOLANA_DEVNET,
    );

    if (!stake.stakeAuthority) {
      throw new Error(
        `witness organization ${organizationId} has no proved stake authority, so the chain ` +
          `source has no account to read for it. Point ACCEPTANCE_STAKED_PROVIDER_ORG_ID at a ` +
          `provider that is staked on chain and has proved a stake authority.`,
      );
    }
    if (!stake.chainReadable) {
      throw new Error(
        `the chain could not be read for witness ${organizationId} (${stake.stakeAuthority}). ` +
          `Step 4 broadcasts two transactions and waits for them, so a run started now would ` +
          `spend before it discovered this. Check SOLANA_RPC_URL on the API server.`,
      );
    }
    if (!stake.hasKnownStake || !stake.staked || stake.staked.amount === '0') {
      throw new Error(
        `the stake source is not reading the chain on this deployment. Witness ` +
          `${organizationId} (${stake.stakeAuthority}) is staked on chain, yet the source reports ` +
          `${stake.hasKnownStake ? `staked=${stake.staked?.amount ?? 'null'}` : 'no reading at all'}` +
          `. Step 4 would stake real devnet USDC into a vault the publish gate cannot see.`,
      );
    }

    return (
      `stake source reads the chain: witness ${organizationId} (${stake.stakeAuthority}) ` +
      `reports staked=${stake.staked.amount} ${stake.staked.asset} ` +
      `chainReadable=${stake.chainReadable}`
    );
  } finally {
    await credential.release();
  }
}

async function main(): Promise<void> {
  // Built before the try so the `finally` can always write it, and printed
  // before anything else so the known-limitations banner leads the output
  // rather than being buried under boot logs.
  const report = new AcceptanceReport();
  report.printHeader();

  // Declared out here, booted inside the `try`: a Postgres that is down, a bad
  // `DATABASE_*` or an entity-metadata error all throw on that boot, and a
  // boot sitting above the `try` would take the report down with it — the one
  // run whose evidence is worth most.
  let identityApp: INestApplicationContext | undefined;
  let exitCode = 0;

  try {
    await step(report, STEP_0, runPreflight);

    identityApp = await bootIdentityContext();

    // Before anything is minted and — the part that matters — before
    // `generateFundedSigner` moves a lamport or a token. Step 0b is the only
    // check in the run that can fail *after* a boot and *before* a spend, which
    // is exactly the window an unreadable stake source has to be caught in. It needs the Nest context (to mint a witness credential) and cannot
    // take `SuiteContext`, which does not exist until the funded signer does.
    await step(report, STEP_0B, () => assertStakeSourceIsChain(identityApp));

    // Named for the actor, not the step: each identity belongs to one actor for
    // the whole run, and both persist as org/agent rows in real Postgres. Two
    // separate organizations — that separation is what makes every later
    // assertion about money crossing between them mean anything.
    //
    // The provider is a PERSON: every provider write is behind
    // `HumanSessionGuard`, which refuses a minted agent credential (review
    // N-2). Its token is a `"kind": "human"` record of the server's
    // `MCP_CREDENTIALS_FILE`, named by ACCEPTANCE_PROVIDER_PERSON_TOKEN, and
    // a fresh one per full run — see `adoptConfigPersonIdentity`. Adopted
    // before any signer is funded, so a stale record costs nothing.
    const providerIdentity = await adoptConfigPersonIdentity(
      identityApp,
      'ACCEPTANCE_PROVIDER_PERSON_TOKEN',
      'provider',
    );
    console.log(
      `provider person identity: organizationId=${providerIdentity.organizationId} ` +
        `agentId=${providerIdentity.agentId}`,
    );

    const { sender, operator } = await bootSender();
    // Steps 1–3 spend none of this; every token is step 4's stake deposit. See
    // PROVIDER_USDC_FUNDING_TOKENS for why 100 and not the exact requirement.
    const providerSigner = await generateFundedSigner(
      sender,
      operator,
      PROVIDER_USDC_FUNDING_TOKENS,
    );
    console.log(`provider signer address: ${providerSigner.address}`);
    // Funded up front, beside the provider's, rather than lazily at step 5:
    // this is the one place in the run where a token-minting CLI call is not
    // competing with a blockhash window, and step 5's whole shape is "nothing
    // slow between create and settle".
    const buyerSigner = await generateFundedSigner(sender, operator, BUYER_USDC_FUNDING_TOKENS);
    console.log(`buyer signer address: ${buyerSigner.address}`);

    // Minted AFTER the signer, and against its address, because per-buyer escrows tied the
    // two together: the buyer's ledger account is the seed of their on-chain
    // escrow, so an identity whose account is not the signer's own pubkey has
    // no escrow that a deposit could ever pay into. Before per-buyer escrows the two were
    // free to differ and this was minted above, beside the provider's.
    const buyerIdentity = await mintScriptIdentity(identityApp, 'buyer', buyerSigner.address);
    console.log(
      `minted buyer identity: organizationId=${buyerIdentity.organizationId} ` +
        `agentId=${buyerIdentity.agentId} account=${buyerIdentity.accountId}`,
    );

    const ctx: SuiteContext = {
      provider: {
        signer: providerSigner,
        api: createApiClient(API_BASE_URL, providerIdentity.token),
        // The routing side of the platform calls a provider by its organization
        // id — see the field's own comment.
        organizationId: providerIdentity.organizationId,
      },
      buyer: {
        signer: buyerSigner,
        api: createApiClient(API_BASE_URL, buyerIdentity.token),
        agentId: buyerIdentity.agentId,
        organizationId: buyerIdentity.organizationId,
        // The ledger account every balance assertion in this run is about.
        // See `SuiteContext.buyer.agentAccount`.
        agentAccount: buyerIdentity.accountId,
      },
      sender,
    };

    await step(report, STEP_1, () => runStep1(ctx));
    await step(report, STEP_2, () => runStep2(ctx));
    await step(report, STEP_3, () => runStep3(ctx));
    await step(report, STEP_4, () => runStep4(ctx));
    await step(report, STEP_5, () => runStep5(ctx));
    // Two records, not one. Steps 6 and 7 could be one function; they are
    // split here because the report is per-step and the two
    // fail for unrelated reasons: "the catalogue never quoted a price" (an MCP
    // server that is down, a binding that published into no routable supply, an
    // SDK that started stripping `_meta` too) and "a paid call did not charge
    // correctly" are different investigations, and a combined record would name
    // whichever happened first for both. They are numbered separately for the
    // same reason, and step 7 is the first step to spend the BUYER's money —
    // step 4's line about being the first to spend the provider's marks the same
    // boundary.
    await step(report, STEP_6, () => runStep6(ctx));
    await step(report, STEP_7, () => runStep7(ctx));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    // Teardown FIRST. `writeToDisk` can throw (an unwritable cwd), and if it
    // did so above this it would both replace the original error and skip the
    // teardown — hanging the process on exactly the handle this exists to
    // release. `app.close()` alone does not release the Postgres pool: see
    // `test/integration/bootstrap/di-wiring.integration.spec.ts` and
    // `deposit.ts`'s identical cleanup.
    // The whole block is best-effort, not just the two awaits inside it:
    // `get()` THROWS `UnknownElementException` for a missing token rather than
    // returning undefined, and an unguarded throw here would skip
    // `writeToDisk()` below — losing the report on exactly the run that needed
    // it. Teardown is best-effort; the report is not.
    try {
      if (identityApp) {
        const dataSource = identityApp.get<DataSource>(getDataSourceToken('postgres'), {
          strict: false,
        });
        await identityApp.close().catch(() => undefined);
        await dataSource?.destroy().catch(() => undefined);
      }
    } catch {
      // Nothing to do — the process is ending either way, and a failure to
      // release a handle must not cost the evidence.
    }

    console.log(`\nreport written to ${report.writeToDisk()}`);
  }

  // `exitCode` is 0 or 1 (something threw). The `||` reads as "unless a step
  // recorded FAILED without throwing" — a soft failure the run is meant to
  // survive, which nothing produces today; it is here so that such a step
  // cannot ship a green exit code.
  process.exitCode = exitCode || (report.hasFailure() ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
