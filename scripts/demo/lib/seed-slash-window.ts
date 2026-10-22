/**
 * Drive a batch of judged calls through the **real** SLA-window write path, so
 * a script can open a real slash proposal without hand-writing a
 * `sla_strikes` or `slash_proposals` row.
 *
 * Extracted out of `seed-slash-case.ts` — this file changes nothing about what
 * that script does; it only gives the "post N calls, then see what the real
 * path produced" part a name and a signature that does not assume
 * `seed-slash-case.ts`'s own hardcoded fixture organization or binding, so a
 * caller that seeds windows on a binding it creates itself can import
 * {@link seedSlaWindowCalls} directly rather than re-deriving this.
 *
 * ## What this does and does not do
 *
 * Every call is posted through **`SlaWindowService.postCall`** — the same
 * seam `VerificationSettlementService.settle()` uses. `postCall` opens the
 * binding's window lazily (or resumes whatever is already open for it), and
 * — entirely inside that service, not called from here — closes it and opens
 * a slash proposal once it reaches the binding's own `min_verified_calls`
 * gate. Nothing in this file re-derives a rate, a threshold or a penalty;
 * {@link seedSlaWindowCalls} only decides *which* calls to post (its caller's
 * job, via {@link SlaWindowSeedCall}) and reads back whatever the real
 * services wrote.
 *
 * The one write that is not through a service is `payment_intents`: the slash
 * compensation split reads what each agent **spent** through that table, and
 * an `sla_window_calls` row alone cannot say whose money a call was (its
 * `agent_id` has no FK, and `organization_id` on that table is the
 * *provider's* tenant). `writeIntent` below leaves behind the row the real
 * call would have, so the split has something to read.
 *
 * ## Whose money the seeded calls are — {@link SlaWindowSeedParams.payers}
 *
 * `SlashCompensationService` splits an executed penalty by reading exactly two
 * columns of that row — `payment_intents.organization_id` and
 * `payment_intents.agent_account` (`SlaWindowCallRepository.sumSpendByAgent`)
 * — so those two columns decide **who gets compensated**, and nothing else
 * does.
 *
 * {@link writeIntent} can *derive* both from the agent id, and for a demo
 * fixture that is the right default: `seed-slash-case.ts` invents its agent
 * ids, so there is no real tenant to name and a deterministic one keeps the
 * seed reproducible. But a derived tenancy is a **fabricated** tenancy — the
 * organization it names has no `organizations` row and the account it names is
 * nobody's `agents.primary_account_id` — so a penalty seeded that way pays its
 * compensation into an organization that does not exist.
 *
 * A caller whose calls are a **real** payer's therefore passes `payers`, and
 * the derivation stays available as the default rather than being the rule.
 * The devnet acceptance suite does this so that step 9 can assert the buyer's
 * own balance moved; `seed-slash-case.ts` passes nothing and is byte-identical
 * to what it was.
 *
 * ## Sharp edges for a caller
 *
 * - **This is slow and it mutates real state.** A binding's SLA window closes
 *   at `MIN_VERIFIED_CALLS` (400 in this codebase's constants) verified
 *   calls, each a real `postCall` against the real database — a full window
 *   is minutes, not seconds, and leaves behind a real `sla_windows` row and,
 *   if it breaches, a real `sla_strikes` / `slash_proposals` row. There is no
 *   dry-run mode; do not try to add one to "test faster" — that would stop
 *   exercising the thing this function exists to exercise.
 * - **Idempotent per `(salt, call.label)`, not per call**: `postCall` keys on
 *   `intentId`, derived here as a stable hash of `${salt}:intent:${label}`,
 *   and `uq_sla_window_calls_intent` is unique globally and permanently. Two
 *   invocations with the same `salt` and the same labels re-derive the same
 *   `intentId`s and post nothing a second time — which silently stalls a
 *   window rather than erroring (see `seed-slash-case.ts`'s file header for
 *   the bug this caused before the caller salted its labels). Give a fresh
 *   `salt` per run, or accept that a repeated `salt` is a no-op.
 * - **`calls` may be empty**, deliberately — a caller resuming a window that
 *   an earlier run already filled needs to be able to pass nothing and get a
 *   graceful `{ window: null, strike: null, proposal: null }` back rather
 *   than an error. A caller that *needs* a window (to publish an edit against
 *   it, say) must check for `null` itself, the way `seed-slash-case.ts` does.
 */

import { createHash } from 'node:crypto';

import { DataSource } from 'typeorm';

import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { SlaWindowEntity } from '@database/postgres/entities/sla-window.entity';
import { SlashProposalEntity } from '@database/postgres/entities/slash-proposal.entity';
import { SlaStrikeRepository } from '@database/postgres/repositories/sla-strike.repository';
import { SlaWindowRepository } from '@database/postgres/repositories/sla-window.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import {
  AssetId,
  ChainId,
  ChainNamespace,
  chainIdOf,
  namespaceOf,
} from '@modules/chains/ports/caip.types';
import { SlaWindowService } from '@modules/provider/services/sla-window.service';

/** One call to post, already decided by the caller — which agent made it,
 * what it was judged, and why. */
export interface SlaWindowSeedCall {
  /** Unique within one {@link seedSlaWindowCalls} run for a given `salt`;
   * combined with `salt` to derive a stable `intentId`. */
  readonly label: string;
  readonly agentId: string;
  /** A `VerdictStatus`, or any string `countsTowardWindow` treats as neither
   * pass nor fail (e.g. `'MISAPPLIED'`) for a call that should land in
   * `total_calls` without moving `verified_calls` / `failed_calls`. */
  readonly verdict: string;
  readonly reasonCode: string | null;
}

/** The services this needs, exactly as `SlaWindowModule` wires them in the
 * real process — see `seed-slash-case.ts` for how to build an application
 * context that provides all five. */
export interface SlaWindowSeedDeps {
  readonly poster: SlaWindowService;
  readonly windows: SlaWindowRepository;
  readonly strikes: SlaStrikeRepository;
  readonly proposals: SlashProposalRepository;
  /** The named `'postgres'` connection — the same token every repository
   * injects — for the one direct write, `payment_intents`. */
  readonly dataSource: DataSource;
}

/**
 * The tenancy behind one agent's seeded calls — the two columns
 * `SlashCompensationService` splits a penalty by. See the file header.
 */
export interface SlaWindowSeedPayer {
  /** The **payer's** own organization, not the provider's. */
  readonly organizationId: string;
  /** CAIP-10, and the ledger `accountId` a compensation credit is written to.
   * For an agent that authenticates through `agents`, this is its
   * `primary_account_id` — the same value its session carries as
   * `agentAccount`. */
  readonly agentAccount: string;
}

export interface SlaWindowSeedParams {
  readonly organizationId: string;
  readonly providerId: string;
  readonly bindingId: string;
  readonly toolId: string;
  readonly assetId: string;
  /** Minor units — what `postCall` and the `payment_intents` row both call
   * `priceAmount`. */
  readonly priceAmount: string;
  /** A per-run salt for this call's `intentId`s. Two runs with the same salt
   * and the same call labels post nothing the second time — see the file
   * header. */
  readonly salt: string;
  /** Posted in order. May be empty — see the file header. */
  readonly calls: readonly SlaWindowSeedCall[];
  /**
   * Real tenancy for the agents that have one, keyed by `SlaWindowSeedCall.agentId`.
   *
   * Keyed rather than flat because one window is several payers by design —
   * `seed-slash-case.ts` fills its windows from five different agents, and a
   * single pair of columns for all of them would credit one agent for
   * everybody's spend.
   *
   * An agent absent from this map falls back to the derived, fabricated
   * tenancy {@link writeIntent} documents. Omitting the field entirely is
   * therefore exactly the old behaviour, which is what keeps
   * `seed-slash-case.ts` unchanged.
   */
  readonly payers?: Readonly<Record<string, SlaWindowSeedPayer>>;
}

export interface SlaWindowSeedResult {
  /** `null` when no call in `calls` ever observed an open window for this
   * binding — either `calls` was empty, or every label in it had already been
   * posted (and its window already closed) by an earlier run with the same
   * `salt`. */
  readonly window: SlaWindowEntity | null;
  /** The strike the window's close wrote, or `null` if it has not closed, or
   * closed without breaching. */
  readonly strike: SlaStrikeEntity | null;
  /** The proposal `SLASH_PROPOSAL_OPENER` opened from that strike, or `null`
   * if there is no strike, or the opener is not bound in this context. */
  readonly proposal: SlashProposalEntity | null;
}

/**
 * Posts every call in `params.calls`, in order, through
 * `SlaWindowService.postCall`, then reads back whichever window they landed
 * in and whatever it produced. See the file header for the idempotency and
 * cost caveats.
 */
export async function seedSlaWindowCalls(
  deps: SlaWindowSeedDeps,
  params: SlaWindowSeedParams,
): Promise<SlaWindowSeedResult> {
  const {
    organizationId,
    providerId,
    bindingId,
    toolId,
    assetId,
    priceAmount,
    salt,
    calls,
    payers,
  } = params;

  let windowId: string | null = null;

  // Once, before the loop: every seeded call in a window is served by the one
  // provider, so this is one read rather than one per call.
  //
  // The chain comes from the ASSET these calls are priced in, which is the
  // chain they settle on — never a deployment default and never the provider's
  // first enrolment. The payout address is per chain, so "the
  // payee" is only a question once a chain has been named.
  const providerAccount = await readPayoutAccount(
    deps.dataSource,
    organizationId,
    assetId as AssetId,
  );

  for (const call of calls) {
    const intentId = uuidFromLabel(`${salt}:intent:${call.label}`);
    await writeIntent(deps.dataSource, {
      intentId,
      agentId: call.agentId,
      organizationId,
      toolId,
      assetId,
      priceAmount,
      providerAccount,
      // `undefined` for an agent the caller did not name, which is every agent
      // when `payers` is omitted — see the file header.
      payer: payers?.[call.agentId],
    });
    await deps.poster.postCall({
      organizationId,
      providerId,
      bindingId,
      toolId,
      intentId,
      agentId: call.agentId,
      verdictStatus: call.verdict,
      reasonCode: call.reasonCode,
      priceAmount,
      assetId,
      postedAt: new Date(),
    });

    // Captured once, right after the first call that lands anywhere — a
    // window that has just accepted one call cannot have closed yet, since
    // every real `min_verified_calls` gate is well above one. Once captured,
    // the id is reused for the rest of this run's calls, whether or not the
    // window is still open by the time they land.
    if (windowId === null) {
      const open = await deps.windows.findOpenForBinding(organizationId, bindingId, assetId);
      if (open) {
        windowId = open.id;
      }
    }
  }

  if (windowId === null) {
    return { window: null, strike: null, proposal: null };
  }

  const window = await deps.windows.findOneBy({ organizationId, id: windowId });
  if (!window) {
    throw new Error(`sla window ${windowId} vanished while seeding ${calls.length} call(s)`);
  }

  const strike = await deps.strikes.findOneBy({ organizationId, windowId: window.id });
  const proposal = strike
    ? await deps.proposals.findOneBy({ organizationId, strikeId: strike.id })
    : null;

  return { window, strike, proposal };
}

/**
 * The `payment_intents` row the call would have left behind. See the file
 * header for why this exists outside any service.
 */
async function writeIntent(
  dataSource: DataSource,
  input: {
    readonly intentId: string;
    readonly agentId: string;
    /** The provider's org — what the row's `provider_id` is set to. */
    readonly organizationId: string;
    readonly toolId: string;
    readonly assetId: string;
    readonly priceAmount: string;
    /** The payer's real tenancy, when the caller knows it. See the file header. */
    readonly payer?: SlaWindowSeedPayer;
    /**
     * The payee — the provider's ACTIVE `provider_chain_enrolments` row on the
     * chain `assetId` settles on, read from the database by
     * {@link seedSlaWindowCalls}, never derived.
     *
     * Required, and deliberately not optional the way {@link payer} is. A
     * `SETTLED` row with no payee is the exact state
     * `chk_payment_intents_settled_names_payee` exists to forbid: it is what
     * `RAIL_A_PER_CALL` looked like for 4,879 intents that settled and paid
     * nobody. Deriving a plausible-looking address here would reproduce that
     * bug in fixture form — a window whose penalty credits an account no
     * provider controls — which is the payer-side trap this file already
     * documents, pointed the other way.
     */
    readonly providerAccount: string;
  },
): Promise<void> {
  // The agent's own tenant, derived from its id — not the provider's. Every
  // agent gets one, because the point of a multi-agent window is several
  // distinct payers sharing it.
  //
  // **Derived is fabricated.** `uuidFromLabel` names an organization that has
  // no `organizations` row, and the `agent_account` below names nobody's
  // `agents.primary_account_id` — so a penalty raised on a window seeded this
  // way pays its compensation into a tenant that does not exist. That is
  // acceptable for a fixture whose agents are invented, and is the reason
  // `input.payer` exists for a caller whose agents are not. See "Whose money
  // the seeded calls are" in the file header.
  const agentOrg =
    input.payer?.organizationId ?? uuidFromLabel(`sla-window-seed:org:${input.agentId}`);
  // On the chain the asset settles on, never a fixed one: a Solana account on
  // an `eip155` intent is a row no balance read can resolve.
  const chainId = chainIdOf(input.assetId as AssetId);
  const agentAccount = input.payer?.agentAccount ?? derivedAgentAccount(chainId, input.agentId);
  // The `6` inlined into the VALUES list below is `decimals` — hardcoded, NOT
  // derived from `input.assetId`. Harmless today (the devnet catalogue has
  // exactly one asset, and it is 6-decimal), but a future caller seeding
  // against a different-decimals asset will get a silently wrong
  // `payment_intents.decimals`. Fix this before relying on it for any asset
  // other than the one this script was written against.
  await dataSource.query(
    `INSERT INTO payment_intents
       (id, organization_id, status, agent_id, agent_account, provider_id, tool_id,
        rail, asset_id, decimals, price_amount, provider_amount, platform_fee,
        request_hash, chain_id, expires_at, call_id, call_class, provider_account)
     VALUES ($1,$2,'SETTLED',$3,$4,$5,$6,'RAIL_A_PER_CALL',$7,6,$8,$9,$10,$11,$12,
             now() + interval '1 day', $13, 'PAID', $14)
     ON CONFLICT (id) DO NOTHING`,
    [
      input.intentId,
      agentOrg,
      input.agentId,
      agentAccount,
      input.organizationId,
      input.toolId,
      input.assetId,
      input.priceAmount,
      input.priceAmount,
      '0',
      `sha256:${uuidFromLabel(`sla-window-seed:hash:${input.intentId}`).replace(/-/g, '')}`,
      chainId,
      uuidFromLabel(`sla-window-seed:call:${input.intentId}`),
      input.providerAccount,
    ],
  );
}

/**
 * The provider's proved payout address **on the chain these calls settle on**
 * — the payee every `SETTLED` row must name.
 *
 * Multichain support moved this off `providers.payout_account_id`, which no longer
 * exists (`1759300000002`). It is now one row per chain in
 * `provider_chain_enrolments`, so the read has to name a chain; it takes it
 * from the seeded calls' own `assetId`, which is CAIP-19 and is the asset they
 * are priced and settled in.
 *
 * `status = 'ACTIVE'`, matching `DbProviderRegistry`. A `SUSPENDED` enrolment
 * is refused by `evaluatePayoutGate`, so a provider in that state could not
 * have published a `PAID` binding and cannot have served a paid call — seeding
 * one would fabricate a state the platform refuses to produce.
 *
 * Read, not derived, and it throws rather than falling back. A provider with
 * no proved payout address on that chain cannot publish a `PAID` binding at
 * all (`evaluatePayoutGate` under the publish gate), so paid calls
 * settled against them describe a state the platform refuses to produce. A
 * fixture that invented an address here would be seeding exactly the
 * corruption the `CHECK` was added to stop, and the run would go green over it.
 */
async function readPayoutAccount(
  dataSource: DataSource,
  organizationId: string,
  assetId: AssetId,
): Promise<string> {
  const chainId = chainIdOf(assetId);

  const rows = (await dataSource.query(
    `SELECT payout_account_id FROM provider_chain_enrolments
      WHERE organization_id = $1 AND chain_id = $2 AND status = 'ACTIVE'`,
    [organizationId, chainId],
  )) as Array<{ payout_account_id: string | null }>;

  const account = rows[0]?.payout_account_id ?? null;
  if (!account) {
    throw new Error(
      `provider org ${organizationId} has no ACTIVE provider_chain_enrolments row on ${chainId} ` +
        `(the chain ${assetId} settles on), so a SETTLED payment_intents row for it would name ` +
        `no payee and violate chk_payment_intents_settled_names_payee. Prove a payout address on ` +
        `that chain first (POST /providers/me/payout-address/challenge, then ` +
        `POST /providers/me/payout-address) — the same proof the publish gate requires before ` +
        `this provider could charge for a call. Note this is per CHAIN: an address ` +
        `proved on another chain does not make this one payable.`,
    );
  }
  return account;
}

/**
 * A deterministic CAIP-10 account for an invented agent, in the shape its chain
 * accepts: a 20-byte address on `eip155` (lower-case hex, which EIP-55 treats
 * as unchecksummed and valid), a 32-character base58-safe string elsewhere.
 */
function derivedAgentAccount(chainId: ChainId, agentId: string): string {
  if (namespaceOf(chainId) === ChainNamespace.EIP155) {
    const address = createHash('sha256')
      .update(`sla-window-seed:account:${agentId}`)
      .digest('hex')
      .slice(0, 40);
    return `${chainId}:0x${address}`;
  }
  return `${chainId}:${agentId.replace(/-/g, '').slice(0, 32)}`;
}

/** A stable, deterministic v4-shaped UUID derived from a label — the same
 * trick `seed-provider-console.ts` and `seed-slash-case.ts` use, so a re-run
 * with the same inputs re-derives the same ids instead of minting new rows. */
export function uuidFromLabel(label: string): string {
  const hash = createHash('sha1').update(label).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    `5${hash.slice(13, 16)}`,
    ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}
