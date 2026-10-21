import { ChainId } from '@modules/chains/ports/caip.types';
import { PayoutGateVerdict } from '@modules/tool/domain/routing/payout-gate';
import { StakeGateVerdict } from '@modules/tool/domain/routing/stake-gate';

import { BindingTestLayer, BindingTestOutcome } from '../ports/binding-test.types';

/**
 * The publish gate — *"an open door still has a step"*.
 *
 * Registration is open and there is no approval step to remove later.
 * What stands between a stranger's binding and paid traffic is three
 * mechanical conditions, none of which is a human reading a submission:
 *
 * ```text
 * TESTER_RUN                        a tester run exists for THIS revision
 * TESTER_PASSED                     that run was green
 * PAYOUT_ACCOUNT                    a proved payee, ON EVERY settlement chain
 * STAKE_AT_MINIMUM_ON_EVERY_CHAIN   stake >= max($50, 1000 × price), per chain
 * ```
 *
 * ## Why the stake requirement names every chain
 *
 * A binding is offered on a **list** of chains, and collateral is per chain and
 * is not shared: a stake on Solana cannot be slashed by a contract on
 * `eip155:4663`. So the two money requirements are asked once per chain in
 * `settlementChains`, and an unmet one is reported **per failing chain**, with
 * the chain named in `detail`.
 *
 * The requirement was renamed rather than parameterised because a provider
 * reading *"STAKE_AT_MINIMUM: not met"* on a two-chain binding has no way to
 * know which chain, and a publish check that cannot say which chain is a
 * publish check nobody can act on.
 *
 * Four conditions, not three. `PAYOUT_ACCOUNT` closes one end of a hole: a PAID
 * binding whose provider has never proved a payout
 * address serves calls that settle with nobody to credit, and the money stays
 * reserved against the agent forever. The other end is the routing gate
 * (`evaluatePayoutGate` under `filterEligible`), which catches an *already
 * published* binding whose address is withdrawn afterwards — this one alone
 * would only ever have been true on the day the button was pressed.
 *
 * It is deliberately allowed to refuse bindings that are already `ACTIVE`. A
 * PAID binding published before this condition existed, with no proved address, is unpayable today;
 * the next revision it publishes is refused, and the checklist says which
 * signature is missing, which is a better outcome than continuing to serve
 * calls that cannot settle.
 *
 * ## Why the revision is part of the first condition
 *
 * "Has this binding ever passed the tester" is the wrong question, and asking
 * it is how a provider tests a correct mapping, edits it, and publishes
 * something nobody ever ran. `mapping_version` moves on every save that
 * changes what the binding does, so a run recorded at revision 3 does not
 * answer for revision 4 — and the gate says so rather than inferring.
 *
 * ## Why this is pure
 *
 * The gate returns a **checklist**, not a boolean, because the publish checklist
 * has to show which condition is missing and by how much — *"if stake is short,
 * publish is locked, with a message saying exactly how much is missing"*. A
 * boolean forces the console to re-derive the reason, and a re-derivation is a
 * second opinion that can disagree with the gate that actually refused.
 *
 * The stake half is not re-implemented here. It arrives as the verdict of
 * `evaluateStakeGate` — the router's own function, the one that decides
 * eligibility for every live call. A binding that satisfied a *publish* copy of
 * that rule and failed the *routing* one would be published and invisible,
 * which is the worst of the available failures: the provider is live, sees no
 * traffic, and nothing tells them why.
 */

export enum PublishRequirement {
  /** A mapping-tester run exists for the revision about to be published. */
  TESTER_RUN = 'TESTER_RUN',
  /** That run passed every layer. */
  TESTER_PASSED = 'TESTER_PASSED',
  /**
   * A payout address is proved **on every chain this binding settles on**, by
   * `evaluatePayoutGate`. `FREE` bindings pass.
   */
  PAYOUT_ACCOUNT = 'PAYOUT_ACCOUNT',
  /**
   * An API-key binding (`API_KEY` or `BOTH`) has a credential set stored for the
   * origin of the endpoint about to go live. Asked only when the input carries
   * {@link PublishGateInput.credentials}.
   */
  API_KEY_CREDENTIALS = 'API_KEY_CREDENTIALS',
  /** `stake >= minimumStake` **on every settlement chain**, by `evaluateStakeGate`. */
  STAKE_AT_MINIMUM_ON_EVERY_CHAIN = 'STAKE_AT_MINIMUM_ON_EVERY_CHAIN',
}

export interface PublishRequirementResult {
  readonly requirement: PublishRequirement;
  readonly met: boolean;
  /** Stable machine-readable reason when unmet, `null` when met. */
  readonly code: string | null;
  /** One human sentence with the specifics — the shortfall, the failed layer. */
  readonly detail: string | null;
  /**
   * T3: the contract major a tester requirement was asked for — one entry per
   * major in the binding's range, met or not. `null` on every other
   * requirement, and on a tester requirement asked without majors.
   */
  readonly major?: number | null;
}

export interface PublishCheck {
  readonly publishable: boolean;
  /** One entry per requirement, always, in a stable order. */
  readonly requirements: readonly PublishRequirementResult[];
}

/** The tester run the gate reads, reduced to what it decides on. */
export interface PublishGateTestRun {
  readonly mappingVersion: number;
  readonly outcome: BindingTestOutcome;
  readonly failedLayer: BindingTestLayer | null;
  readonly ranAt: Date;
}

export interface PublishGateInput {
  /** The revision that would go live. */
  readonly mappingVersion: number;
  /**
   * Earlier revisions whose call is the same as {@link mappingVersion}'s
   * (`revisionsWithSameCall`: only the price, the pricing mode, the asset or
   * the chains differ). A run at one of them counts as a run at this revision
   * (BUG-PRV-CATALOG-02). Absent or empty: only `mappingVersion` counts.
   */
  readonly sameCallRevisions?: readonly number[];
  /**
   * The newest run **for that revision**, or `null` when there is none.
   *
   * Selecting by revision is the repository's job (`findLatestForRevision`);
   * this function still re-checks it, because a caller that passed the wrong
   * run would otherwise publish an untested mapping and the gate would agree.
   */
  readonly latestRun: PublishGateTestRun | null;
  /**
   * The router's own payout verdict, **one per settlement chain**.
   *
   * Same arrangement as {@link stakeByChain} and for the same reason: it is
   * `evaluatePayoutGate`, the function `filterEligible` runs on every live
   * call. A binding that satisfied a publish-only copy of the rule and failed
   * the routing one would be published and invisible.
   *
   * An **empty** map is not a pass. A binding offered on no chain is a binding
   * nothing can route, and vacuously ticking a checklist for it would publish
   * exactly that — see {@link chainedRequirement}.
   */
  readonly payoutByChain: ReadonlyMap<ChainId, PayoutGateVerdict>;
  /** The router's own stake verdict, one per settlement chain. */
  readonly stakeByChain: ReadonlyMap<ChainId, StakeGateVerdict>;
  /**
   * T3: the newest run at this revision **per contract major the binding
   * serves** (`tool_version_range`), `null` for a major never tested. When
   * given, the two tester requirements are asked once per major (§7.5: a
   * major needs a re-map and a passing test run for that major), and
   * {@link latestRun} is not read.
   */
  readonly runsByMajor?: ReadonlyMap<number, PublishGateTestRun | null>;
  /**
   * The credential facts for an API-key binding: whether the auth mode needs a
   * key, the origin the endpoint will call, and whether a set is stored for it.
   * Absent, the requirement is not asked.
   */
  readonly credentials?: {
    readonly required: boolean;
    readonly origin: string;
    readonly present: boolean;
  };
}

export function evaluatePublishGate(input: PublishGateInput): PublishCheck {
  const requirements = [
    ...perMajor(input, testerRunRequirement, PublishRequirement.TESTER_RUN),
    ...perMajor(input, testerPassedRequirement, PublishRequirement.TESTER_PASSED),
    ...credentialRequirements(input),
    ...payoutRequirements(input),
    ...stakeRequirements(input),
  ].map((result) => ({ ...result, major: result.major ?? null }));

  return {
    publishable: requirements.every((requirement) => requirement.met),
    requirements,
  };
}

/**
 * A tester requirement asked once per contract major in the binding's range:
 * one entry per major, met or not, each carrying its `major` (unmet ones
 * also name it in `detail`), so the checklist shows every major's own result.
 */
function perMajor(
  input: PublishGateInput,
  requirementOf: (input: PublishGateInput) => PublishRequirementResult,
  requirement: PublishRequirement,
): readonly PublishRequirementResult[] {
  if (!input.runsByMajor) return [{ ...requirementOf(input), major: null }];
  if (input.runsByMajor.size === 0) {
    return [
      {
        requirement,
        met: false,
        code: 'no_contract_major',
        detail: 'This binding serves no contract major, so there is nothing to test it against.',
        major: null,
      },
    ];
  }
  return [...input.runsByMajor]
    .sort(([a], [b]) => a - b)
    .map(([major, run]) => {
      const result = requirementOf({ ...input, latestRun: run, runsByMajor: undefined });
      return result.met
        ? { ...result, major }
        : { ...result, major, detail: `Contract v${major}: ${result.detail ?? ''}`.trim() };
    });
}

/** Whether a run at `revision` vouches for the revision that would go live. */
function countsFor(input: PublishGateInput, revision: number): boolean {
  return revision === input.mappingVersion || (input.sameCallRevisions ?? []).includes(revision);
}

function testerRunRequirement(input: PublishGateInput): PublishRequirementResult {
  const { latestRun, mappingVersion } = input;

  if (!latestRun) {
    return {
      requirement: PublishRequirement.TESTER_RUN,
      met: false,
      code: 'tester_never_run',
      detail: `No mapping-tester run for revision ${mappingVersion}. Run the tester before publishing.`,
    };
  }

  if (!countsFor(input, latestRun.mappingVersion)) {
    return {
      requirement: PublishRequirement.TESTER_RUN,
      met: false,
      code: 'tester_run_is_stale',
      detail:
        `The newest tester run is for revision ${latestRun.mappingVersion}, ` +
        `and revision ${mappingVersion} is what would go live. Run the tester again.`,
    };
  }

  return { requirement: PublishRequirement.TESTER_RUN, met: true, code: null, detail: null };
}

/**
 * Unmet — not vacuously met — when no run exists.
 *
 * Both requirements failing for one missing run is deliberate. The console draws a
 * checklist, and a tick beside "the tester passed" on a binding that was never
 * tested is a lie the reader has no way to catch.
 */
function testerPassedRequirement(input: PublishGateInput): PublishRequirementResult {
  const { latestRun, mappingVersion } = input;

  if (!latestRun || !countsFor(input, latestRun.mappingVersion)) {
    return {
      requirement: PublishRequirement.TESTER_PASSED,
      met: false,
      code: 'tester_never_run',
      detail: `Nothing has been tested at revision ${mappingVersion}.`,
    };
  }

  if (latestRun.outcome !== BindingTestOutcome.PASSED) {
    return {
      requirement: PublishRequirement.TESTER_PASSED,
      met: false,
      code: 'tester_failed',
      detail: `The last tester run failed at the ${latestRun.failedLayer ?? 'unknown'} layer.`,
    };
  }

  return { requirement: PublishRequirement.TESTER_PASSED, met: true, code: null, detail: null };
}

/**
 * An API-key binding cannot go live without its key: every call would reach the
 * provider unauthenticated, or, with the runtime guard, be refused as a platform
 * fault. The detail tells the provider what to do.
 */
function credentialRequirements(input: PublishGateInput): readonly PublishRequirementResult[] {
  const { credentials } = input;
  if (!credentials) return [];
  if (!credentials.required || credentials.present) {
    return [
      { requirement: PublishRequirement.API_KEY_CREDENTIALS, met: true, code: null, detail: null },
    ];
  }
  return [
    {
      requirement: PublishRequirement.API_KEY_CREDENTIALS,
      met: false,
      code: 'credentials_missing_for_origin',
      detail:
        `No API key is stored for ${credentials.origin}. Add it under Authentication → ` +
        `API key, or set the authentication mode to none or signature only.`,
    },
  ];
}

/**
 * Where a settled call pays this provider, **on each chain it is offered on**.
 *
 * Reported *before* the stake requirement, matching `filterEligible`'s own
 * order: a provider sent to top up their stake when the real problem is a
 * missing signature has been sent to fix the wrong thing, and unlike a
 * shortfall this one cannot be fixed by moving money at all.
 */
function payoutRequirements(input: PublishGateInput): readonly PublishRequirementResult[] {
  return chainedRequirement(PublishRequirement.PAYOUT_ACCOUNT, input.payoutByChain, (failure) => ({
    // The router's own reason verbatim, so the console shows the same word
    // for "unpayable" whether the binding was refused at publish or at
    // routing.
    code: failure.reason,
    detail:
      `${failure.detail}. Prove a payout address from the wallet you want paying ` +
      `before publishing a paid binding.`,
  }));
}

function stakeRequirements(input: PublishGateInput): readonly PublishRequirementResult[] {
  return chainedRequirement(
    PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    input.stakeByChain,
    (failure) => ({
      // The router's own reason, verbatim: `STAKE_BELOW_MINIMUM`,
      // `STAKE_UNKNOWN` or `STAKE_ASSET_MISMATCH`. A provider who tops up on
      // the strength of a "below minimum" message when the real problem was a
      // stake source outage has been sent to fix the wrong thing.
      code: failure.reason,
      detail: failure.detail,
    }),
  );
}

/** A verdict that either passed or carries a reason and a detail. */
type ChainVerdict =
  | { readonly passed: true }
  | { readonly passed: false; readonly reason: string; readonly detail: string };

/**
 * One requirement asked once per settlement chain.
 *
 * Met → exactly one entry, so the checklist keeps its stable shape. Unmet →
 * **one entry per failing chain**, each naming its chain first in `detail`,
 * because a provider staked on one of two chains has one thing to fix and needs
 * to be told which.
 *
 * An empty map is **unmet**, not vacuously met. `[].every(...)` is `true`, and
 * a binding offered on no chain reaching this function would otherwise publish
 * with every requirement ticked — a live binding nothing can route, which is
 * the failure this gate exists to prevent. The row's own CHECK forbids the
 * empty list, so this is the belt to that braces.
 */
function chainedRequirement(
  requirement: PublishRequirement,
  verdicts: ReadonlyMap<ChainId, ChainVerdict>,
  describe: (failure: Extract<ChainVerdict, { passed: false }>) => {
    code: string;
    detail: string;
  },
): readonly PublishRequirementResult[] {
  if (verdicts.size === 0) {
    return [
      {
        requirement,
        met: false,
        code: 'no_settlement_chain',
        detail: 'This binding names no settlement chain, so there is nothing to check it on.',
      },
    ];
  }

  const failures: PublishRequirementResult[] = [];
  for (const [chainId, verdict] of verdicts) {
    if (verdict.passed) continue;

    // Cast rather than narrowing: this project compiles with
    // `strictNullChecks: false`, under which TypeScript does not narrow a
    // discriminated union by its literal-boolean tag. The `continue` above is
    // the proof, not the compiler.
    const described = describe(verdict as Extract<ChainVerdict, { passed: false }>);
    failures.push({
      requirement,
      met: false,
      code: described.code,
      detail: `${chainId}: ${described.detail}`,
    });
  }

  if (failures.length === 0) {
    return [{ requirement, met: true, code: null, detail: null }];
  }

  return failures;
}

/** The unmet requirements, for an error's context. */
export function unmetRequirements(check: PublishCheck): readonly PublishRequirementResult[] {
  return check.requirements.filter((requirement) => !requirement.met);
}
