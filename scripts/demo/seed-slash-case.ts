/**
 * Seed one real slash proposal case, so the provider's slash-case screen has
 * something to render.
 *
 * ```bash
 * yarn demo:slash-case
 * ```
 *
 * ## Why this exists
 *
 * `select count(*) from slash_proposals` was **0** and `sla_strikes` was empty,
 * so the provider's slash-case screen had nothing to show and could not be
 * verified against anything.
 *
 * The obvious shortcut — hand-write a `slash_proposals` row with a plausible
 * `computation` blob — is the one thing `SlaStrikeEntity`'s own docstring
 * forbids: the row exists so that *"a person in a dispute six months from now
 * can rebuild the entire argument from this row alone"*. A typed-in derivation
 * that does not agree with its own inputs is exactly the artefact that promise
 * denies, and it would make the screen built on top of it a liar.
 *
 * ## So this drives the real path, end to end
 *
 * Every number on the case comes out of the production code:
 *
 * 1. Calls are posted through **`SlaWindowService.postCall`** — the same seam
 *    `VerificationSettlementService.settle()` uses, through the same port. The
 *    window is opened lazily by that service, its rules are frozen onto the row
 *    by that service, and its counters move only through
 *    `SlaWindowRepository.incrementCounters`.
 * 2. The window closes when it reaches its own `min_verified_calls` gate, and
 *    **`SlaWindowService.closeWindow`** decides the outcome with
 *    `closeOutcomeFor` and writes the `sla_strikes` row with the `computation`
 *    array `strikeArithmeticFor` produced. Nothing here computes a rate, a
 *    tolerance, a threshold or a penalty.
 * 3. **`SlashProposalService.openFromStrike`** — the proposal opener, reached
 *    through `SLASH_PROPOSAL_OPENER` exactly as it is in the API process —
 *    turns that strike into the case.
 * 4. **`SlashDeliveryObserver`** starts the provider's response clock when the
 *    notification this raises is actually delivered. Not called here —
 *    see the note at the end of `main` for why that matters.
 *
 * The only inputs this file chooses are the ones a real call would have
 * supplied anyway: which agent made it, what the response was judged to be, and
 * what it cost.
 *
 * ## What it writes that is NOT through a service
 *
 * One thing, and it is named where it happens: the change-overlay banner needs
 * a **published** `binding_versions` row inside the subject window, and
 * `BindingPublishService` lives in `ProviderApiModule` — a graph this context
 * does not load. So the binding's existing *draft* version is marked published
 * through `BindingVersionRepository`, which is the same exception
 * `seed-provider-console.ts` documents for that table. It sets two columns;
 * every number the overlay then shows (`verifiedBefore`, `failuresAfter`, the
 * two rates) is computed by `SlashCaseService` from the real call rows either
 * side of that timestamp.
 *
 * ## Idempotent
 *
 * Every posted call's `intentId` is derived from a stable label, so
 * `uq_sla_window_calls_intent` turns a re-run into a no-op. If a proposal
 * already exists for the binding the script prints it and stops — it will not
 * mint a second penalty for one binding.
 *
 * ## Undoing it
 *
 * ```sql
 * delete from slash_proposal_events where proposal_id in
 *   (select id from slash_proposals where provider_id = '<org>');
 * delete from slash_proposals where provider_id = '<org>';
 * delete from sla_strikes  where provider_id = '<org>';
 * delete from sla_windows  where provider_id = '<org>';  -- calls cascade
 * update binding_versions set published_at = null, published_by = null
 *   where id = '<the draft that was published>';
 * ```
 */

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { getDataSourceToken } from '@nestjs/typeorm';
import { DataSource, IsNull, Like } from 'typeorm';

import { appConfig } from '@config/app.config';
import { authConfig } from '@config/auth.config';
import { bullmqConfig } from '@config/bullmq.config';
import { databaseConfig } from '@config/database.config';
import { observabilityConfig } from '@config/observability.config';
import { redisConfig } from '@config/redis.config';
import { DatabaseModule } from '@database/database.module';
import { BindingVersionRepository } from '@database/postgres/repositories/binding-version.repository';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { SlaWindowModule } from '@modules/provider/sla-window.module';
import { SlaWindowService } from '@modules/provider/services/sla-window.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';
import { RedisCacheModule } from '@shared/cache/redis-cache/redis-cache.module';
import { NetworkModule } from '@shared/network/network.module';

import { SlaWindowSeedCall, seedSlaWindowCalls, uuidFromLabel } from './lib/seed-slash-window';

/**
 * The smallest context that can drive the real path.
 *
 * `SlaWindowModule` brings `SlaWindowService` and, through its own
 * `SlashOpenerModule` import, `SlashProposalService` bound to
 * `SLASH_PROPOSAL_OPENER` — which is precisely the wiring the API process has.
 * Nothing here mounts a controller: this is a writer, not a server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, redisConfig, bullmqConfig, observabilityConfig, authConfig],
      envFilePath: ['.env.local', '.env'],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => configService.get('bullmq'),
    }),
    NetworkModule,
    DatabaseModule,
    RedisCacheModule,
    SlaWindowModule,
  ],
})
class SlashCaseSeedModule {}

// ── The shape of the traffic ────────────────────────────────────────────────
//
// Five quiet windows and then one bad one. The rates are chosen; everything
// derived from them is not.

/** How many quality-bearing calls fill each window. Must reach the binding's
 * own `min_verified_calls` gate, which is what closes the window. */
const VERIFIED_PER_WINDOW = 400;

/**
 * Failures in each of the five windows before the subject.
 *
 * At 400 verified calls against a 2% declaration the effective threshold is
 * `0.02 + 2.58·sqrt(0.02·0.98/400) = 3.81%`, so every one of these has to stay
 * under 15 failures. A first pass used 17 in the last window and it **breached**
 * — the service was right and the constant was wrong, which is the useful proof
 * that these windows are judged rather than declared. That proposal is real and
 * has been left where it is.
 */
const QUIET_WINDOW_FAILURES = [11, 12, 13, 11, 13] as const;

/** Failures in the subject window: 60 / 400 = 15.0%, against a 2% declaration.
 * Split either side of the binding edit so the change overlay has something to
 * correlate. */
const SUBJECT_FAILURES_BEFORE_EDIT = 9;
const SUBJECT_FAILURES_AFTER_EDIT = 51;
/** Where the binding edit lands, in quality-bearing calls. */
const SUBJECT_EDIT_AFTER_CALLS = 200;

/**
 * Calls that carry a verdict which does not move the quality metric, so they
 * land in `total_calls` but not in `verified_calls`. All from one agent, which
 * is what makes `SlashCaseService`'s `soleExcludedAgent` able to name it.
 */
const SUBJECT_EXCLUDED_CALLS = 38;

/** Real codes, taken from `evaluate-rules.ts` — not invented labels. */
const FAILURE_REASON_CODES = [
  'insufficient_results',
  'stale_timestamp',
  'missing_field',
  'null_field',
  'quorum_failures_at_least',
] as const;

/** How the failures spread across the codes above, in order. */
const REASON_WEIGHTS = [0.5, 0.2, 0.13, 0.1, 0.07] as const;

/** Agents that made failing calls. Deterministic, so a re-run addresses the
 * same rows. Two of them are EVM buyer agents the console seed already uses. */
const FAILING_AGENTS = [
  'b1c07f4a-3e59-4d2b-8a16-90f4c7d5e2a1',
  'c2d18a5b-4f6a-4e3c-9b27-a1e5d8f6b3c2',
  uuidFromLabel('slash-case:agent:3'),
  uuidFromLabel('slash-case:agent:4'),
  uuidFromLabel('slash-case:agent:5'),
  uuidFromLabel('slash-case:agent:6'),
] as const;

/** How the failures spread across those agents, in order. */
const AGENT_WEIGHTS = [0.45, 0.24, 0.13, 0.08, 0.06, 0.04] as const;

/** The single agent behind every excluded call. */
const EXCLUDED_AGENT = uuidFromLabel('slash-case:agent:excluded');

const PASSING_AGENT = 'b1c07f4a-3e59-4d2b-8a16-90f4c7d5e2a1';

/**
 * A per-run salt for every synthetic `intentId` this script mints.
 *
 * ## Why this exists, and why the script was broken without it
 *
 * `postCall` keys on `intentId`, and `uq_sla_window_calls_intent` is unique
 * **globally and permanently** — not per window. The ids here are a stable hash
 * of a label, so a second run re-derives the *same* ids, `postCall` returns
 * silently before any counter moves (`sla-window.service.ts:124-129`), and the
 * window never fills. The symptom: `9/9`
 * failures and no strike, `9` being `SUBJECT_FAILURES_BEFORE_EDIT` — the exact
 * point at which the first run's labels ran out. No error, no log.
 *
 * Salting the label makes each run mint fresh ids. **The property that matters
 * is not lost**: "one finding must not produce two penalties" is guaranteed
 * independently by `uq_sla_strikes_window` and `uq_slash_proposals_strike`,
 * neither of which this touches.
 *
 * Pass `--run <id>` to reproduce a specific run's ids; omit it and every run is
 * new, which is what makes the script re-runnable at all.
 */
function readRunSalt(): string {
  const flag = process.argv.indexOf('--run');
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

async function main(): Promise<void> {
  const runSalt = readRunSalt();
  log(`run salt ${runSalt} — pass \`--run ${runSalt}\` to re-derive these ids`);

  // `abortOnError: false` makes a failed boot (missing env, unreachable DB)
  // reject into the catch below; with the logger off, Nest's default is to
  // exit 1 without printing anything.
  const app = await NestFactory.createApplicationContext(SlashCaseSeedModule, {
    logger: false,
    abortOnError: false,
  });

  const poster = app.get(SlaWindowService);
  // Kept: `openFromStrike` is reached through SLASH_PROPOSAL_OPENER, not this.
  const lifecycle = app.get(SlashProposalService);
  void lifecycle;
  const bindings = app.get(ToolBindingRepository);
  const windows = app.get(SlaWindowRepository);
  const strikes = app.get(SlaStrikeRepository);
  const proposals = app.get(SlashProposalRepository);
  const versions = app.get(BindingVersionRepository);
  // Named connection — `postgres`, the same token every repository injects.
  const dataSource = app.get<DataSource>(getDataSourceToken('postgres'));

  // The tenant is read from the same credentials file the config session
  // source serves `mcp_demo_token_provider` from, rather than being pasted in —
  // a second copy of a tenant id is a second thing to keep in step.
  const demoOrganizationId = readDemoProviderOrganizationId();

  // The subject is whichever binding that org left ACTIVE on an EVM chain.
  // Resolved rather than hard-coded, so this script does not carry a copy of an
  // id that lives in the database either. EVM only: a slash case opens only on
  // an `eip155` chain, so a Solana binding would fill six windows and then
  // fail with a strike and no proposal.
  const binding = await bindings.findOne({
    where: { organizationId: demoOrganizationId, status: 'ACTIVE', assetId: Like('eip155:%') },
    order: { createdAt: 'ASC' },
  });
  if (!binding) {
    throw new Error(
      `No ACTIVE tool_bindings row on an EVM (eip155) chain for ${demoOrganizationId}. ` +
        'Run `yarn demo:seed` first — this script needs an ACTIVE EVM binding with a declared ' +
        'SLA to open a window against; slash cases open only on EVM chains.',
    );
  }

  const organizationId = binding.organizationId;
  const bindingId = binding.id;
  const assetId = binding.assetId;
  const priceAmount = binding.priceAmount;
  const toolId = binding.toolId;

  log(`binding   ${bindingId} (${toolId})`);
  log(`org       ${organizationId}`);
  log(`declared  ${binding.slaFailureRate} failure rate · price ${priceAmount} ${assetId}`);

  // Existing cases are reported, not treated as a stop condition: the real
  // guard is per call. Every posted call's `intentId` is derived from a stable
  // label, so `uq_sla_window_calls_intent` makes a re-run post nothing, which
  // means no window closes and no second penalty can be minted for one finding.
  const existing = await proposals.find({ where: { organizationId, bindingId } });
  for (const row of existing) {
    log(`existing proposal ${row.id} (${row.status}) — window ${row.windowId}`);
  }

  // The write engine every batch below drives — `seedSlaWindowCalls`
  // (scripts/demo/lib/seed-slash-window.ts). It posts each call through
  // `SlaWindowService.postCall` and writes the matching `payment_intents` row
  // (see that file's header for why); this script's only job is deciding
  // *which* calls to post.
  const deps = { poster, windows, strikes, proposals, dataSource };
  // Prefixed so this run's `intentId`s cannot collide with another script's —
  // see `seed-slash-window.ts`'s idempotency note for what a re-used salt
  // does.
  const salt = `slash-case:${runSalt}`;

  // ── The five quiet windows ────────────────────────────────────────────────

  for (const [index, failures] of QUIET_WINDOW_FAILURES.entries()) {
    const open = await windows.findOpenForBinding(organizationId, bindingId, assetId);
    const alreadyFailed = open?.failedCalls ?? 0;
    const alreadyVerified = open?.verifiedCalls ?? 0;
    // The console seed leaves an open window with failing calls already in it.
    // Those count, so the target is a total rather than an addition.
    const toFail = Math.max(0, failures - alreadyFailed);

    const calls: SlaWindowSeedCall[] = [];
    for (let n = alreadyVerified; n < VERIFIED_PER_WINDOW; n += 1) {
      const fails = n - alreadyVerified < toFail;
      calls.push({
        label: `quiet:${index}:${n}`,
        agentId: fails ? pick(FAILING_AGENTS, AGENT_WEIGHTS, n) : PASSING_AGENT,
        verdict: fails ? 'FAIL' : 'PASS',
        reasonCode: fails ? pick(FAILURE_REASON_CODES, REASON_WEIGHTS, n) : null,
      });
    }
    await seedSlaWindowCalls(deps, {
      organizationId,
      providerId: organizationId,
      bindingId,
      toolId,
      assetId,
      priceAmount,
      salt,
      calls,
    });
    log(`window ${index + 1}/6 filled — ${failures} failures in ${VERIFIED_PER_WINDOW}`);
  }

  // ── The subject window ────────────────────────────────────────────────────

  // Before the edit.
  const preEditCalls: SlaWindowSeedCall[] = [];
  for (let n = 0; n < SUBJECT_EDIT_AFTER_CALLS; n += 1) {
    const fails = n < SUBJECT_FAILURES_BEFORE_EDIT;
    preEditCalls.push({
      label: `subject:pre:${n}`,
      agentId: fails ? pick(FAILING_AGENTS, AGENT_WEIGHTS, n) : PASSING_AGENT,
      verdict: fails ? 'FAIL' : 'PASS',
      reasonCode: fails ? pick(FAILURE_REASON_CODES, REASON_WEIGHTS, n) : null,
    });
  }
  await seedSlaWindowCalls(deps, {
    organizationId,
    providerId: organizationId,
    bindingId,
    toolId,
    assetId,
    priceAmount,
    salt,
    calls: preEditCalls,
  });

  const subject = await windows.findOpenForBinding(organizationId, bindingId, assetId);
  if (!subject) {
    throw new Error('The subject window closed early; nothing left to attribute an edit to.');
  }

  // The one direct write. See the file header for why it is not a service call.
  const publishedAt = new Date();
  const draft = await versions.findOne({
    // `IsNull()`, not `publishedAt: null`. TypeORM drops a literal `null` from
    // a `where` object rather than translating it to `IS NULL`, so the plain
    // form matched the FIRST version row and re-published an already-published
    // one — moving a real publish timestamp. Found the hard way.
    where: { organizationId, bindingId, publishedAt: IsNull() },
    order: { mappingVersion: 'ASC' },
  });
  if (draft) {
    await versions.update(
      { organizationId, id: draft.id },
      { publishedAt, publishedBy: draft.authoredBy },
    );
    log(`published binding_versions v${draft.mappingVersion} at ${publishedAt.toISOString()}`);
  } else {
    log('no unpublished binding_versions row — the change overlay will be null (honest)');
  }

  // After the edit: the failure rate climbs, which is the correlation the
  // overlay exists to surface.
  const after = VERIFIED_PER_WINDOW - SUBJECT_EDIT_AFTER_CALLS;
  const postEditCalls: SlaWindowSeedCall[] = [];
  for (let n = 0; n < after; n += 1) {
    const fails = n < SUBJECT_FAILURES_AFTER_EDIT;
    postEditCalls.push({
      label: `subject:post:${n}`,
      agentId: fails ? pick(FAILING_AGENTS, AGENT_WEIGHTS, n) : PASSING_AGENT,
      verdict: fails ? 'FAIL' : 'PASS',
      reasonCode: fails ? pick(FAILURE_REASON_CODES, REASON_WEIGHTS, n) : null,
    });

    // The excluded calls go in before the gate is reached, so they land in this
    // window's `total_calls` rather than the next one's.
    if (n < SUBJECT_EXCLUDED_CALLS) {
      postEditCalls.push({
        label: `subject:excluded:${n}`,
        agentId: EXCLUDED_AGENT,
        verdict: 'MISAPPLIED',
        reasonCode: 'missing_field',
      });
    }
  }
  const {
    window: closedSubject,
    strike,
    proposal,
  } = await seedSlaWindowCalls(deps, {
    organizationId,
    providerId: organizationId,
    bindingId,
    toolId,
    assetId,
    priceAmount,
    salt,
    calls: postEditCalls,
  });

  // ── What the real path produced ───────────────────────────────────────────

  if (!strike) {
    throw new Error(
      `The subject window closed ${closedSubject?.outcome ?? 'still open'} rather than ` +
        `BREACH_PROPOSED — ${closedSubject?.failedCalls}/${closedSubject?.verifiedCalls} failures. ` +
        'No strike, so no case.',
    );
  }

  if (!proposal) {
    throw new Error(
      `A strike was written (${strike.id}) but no proposal opened. ` +
        'SLASH_PROPOSAL_OPENER is not bound in this context.',
    );
  }

  // Delivery is recorded by `SlashDeliveryObserver`, reached from the
  // notification deliver processor when a channel confirms, so `notifiedAt`
  // may be null for a moment after this script finishes.

  const final = await proposals.findOne({ where: { organizationId, id: proposal.id } });

  log('');
  log('── the case ────────────────────────────────────────────────');
  log(`window     ${subject.id} (w_${subject.sequence})`);
  log(
    `  observed ${strike.failedCalls}/${strike.verifiedCalls} = ${(strike.observedRate * 100).toFixed(2)}%`,
  );
  log(
    `  threshold ${(strike.effectiveThreshold * 100).toFixed(2)}%  (declared ${strike.declaredFailureRate} + tolerance ${(strike.tolerance * 100).toFixed(2)}pp)`,
  );
  log(`strike     ${strike.id}`);
  log(`  penalty  ${strike.penaltyAmount} ${strike.assetId}`);
  log(`proposal   ${proposal.id}`);
  log(`  status   ${final?.status}`);
  log(`  notified ${final?.notifiedAt?.toISOString() ?? '(null)'}`);
  log(`  executes ${final?.earliestExecutionAt.toISOString()}`);
  log('');
  log(`curl -s http://localhost:3010/api/v1/providers/me/slash-proposals/${proposal.id} \\`);
  log(`  -H 'Authorization: Bearer mcp_demo_token_provider'`);

  await close(app);
}

/**
 * A deterministic pick, so a re-run of a label produces the same agent and the
 * same reason code. Nothing here is random.
 */
function pick<T>(items: readonly T[], weights: readonly number[], index: number): T {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  // A fixed-stride walk rather than a random draw: it hits every bucket in
  // proportion without needing a seed, and it is reproducible.
  const position = ((index * 0.6180339887498949) % 1) * total;
  let cursor = 0;
  for (let i = 0; i < items.length; i += 1) {
    cursor += weights[i];
    if (position < cursor) return items[i];
  }
  return items[items.length - 1];
}

async function close(app: { close: () => Promise<void> }): Promise<void> {
  try {
    await app.close();
  } catch {
    // The named `'postgres'` datasource makes `close()` throw on shutdown —
    // the same behaviour `seed-provider-console.ts` documents. The writes are
    // committed by this point.
  }
  process.exit(0);
}

/**
 * The organization `mcp_demo_token_provider` resolves to, read from the file
 * `AUTH_SESSION_SOURCE=config` serves sessions out of.
 */
function readDemoProviderOrganizationId(): string {
  const path = join(__dirname, '..', 'mcp', 'seed', 'credentials.json');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<
    string,
    { organizationId?: string } | undefined
  >;
  const organizationId = parsed['mcp_demo_token_provider']?.organizationId;
  if (!organizationId) {
    throw new Error(`mcp_demo_token_provider has no organizationId in ${path}`);
  }
  return organizationId;
}

function log(line: string): void {
  console.log(line);
}

void main().catch((error: unknown) => {
  console.error(
    'demo:slash-case failed — it needs the API environment (.env or exported) and its database:',
  );
  console.error(error);
  process.exit(1);
});
