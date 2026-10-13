import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  IneligibilityReason,
  RoutingContext,
  chainsWithheldForWithdrawal,
  filterEligible,
  settleableChains,
} from '@modules/tool/domain/routing';

import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { AppError } from '@shared/errors/app-errors';

import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { FakeEscrowReader, SESSION, buildMcpHarness } from '../mcp/helpers/mcp-harness';
import {
  MINIMUM_STAKE_BY_CHAIN,
  PAYOUT_ACCOUNT,
  ScriptedInvoker,
  TOOL_ID,
  buildBinding,
  buildCandidate,
  buildProvider,
  buildRouter,
  ok,
  usdc,
} from './helpers/routing-fixtures';

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

/**
 * The floor on BOTH chains, for the reason `routing-chains.spec.ts` states at
 * its own copy: with a real mainnet floor in mainnet USDC a binding priced in
 * devnet USDC is refused `STAKE_ASSET_MISMATCH` before any number is compared,
 * and the case would go green having proved nothing.
 */
const FLOOR_ON_BOTH = new Map([
  [DEVNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
  [MAINNET, MINIMUM_STAKE_BY_CHAIN.get(DEVNET)],
]) as typeof MINIMUM_STAKE_BY_CHAIN;

/**
 * The withdrawal rule from `docs/gas.md` in the EVM repository (assay-evm) — the
 * half that had no implementation.
 *
 * `EscrowSpendGateService` already refuses to ACCEPT a voucher from a buyer with
 * a standing withdrawal. This is the other half: not quoting them in the first
 * place, which is the half the buyer actually sees.
 *
 * The arithmetic that makes it necessary: a withdrawal requested at `T` matures
 * at `T + 3600`; a voucher is redeemable until `expiresAt + 1800` and
 * `expiresAt` may be `300` past `issuedAt`. So a voucher signed at `T + 1381`
 * or later can still be redeemable after the withdrawal has been taken, and
 * `withdraw()` reads no outstanding-voucher state — it pays
 * `min(requested, balance)` and the redemption then fails `EscrowInsufficient`
 * with the provider having already served.
 */
describe('a buyer with a standing withdrawal is not quoted on that chain', () => {
  /** A candidate offered, enrolled, payable and bonded on BOTH chains. */
  const candidateOnBoth = buildCandidate('p', {
    binding: { settlementChains: [DEVNET, MAINNET] },
    settlementChains: [DEVNET, MAINNET],
    stakeByChain: new Map([
      [DEVNET, { providerId: 'p', chainId: DEVNET, staked: usdc(1000), observedAt: new Date(0) }],
      [MAINNET, { providerId: 'p', chainId: MAINNET, staked: usdc(1000), observedAt: new Date(0) }],
    ]),
    provider: {
      payoutAccountByChain: new Map([
        [DEVNET, PAYOUT_ACCOUNT],
        [MAINNET, PAYOUT_ACCOUNT],
      ]),
    },
  });

  /** The same, on MAINNET alone. */
  const candidateOnMainnet = buildCandidate('q', {
    binding: { settlementChains: [MAINNET] },
    settlementChains: [MAINNET],
    stakeByChain: new Map([
      [MAINNET, { providerId: 'q', chainId: MAINNET, staked: usdc(1000), observedAt: new Date(0) }],
    ]),
    provider: { payoutAccountByChain: new Map([[MAINNET, PAYOUT_ACCOUNT]]) },
  });

  const base: RoutingContext = {
    payerChains: [DEVNET, MAINNET],
    enabledChains: [DEVNET, MAINNET],
    defaultChainId: DEVNET,
    withdrawingChains: [],
  };

  it('drops a chain the buyer is withdrawing from', () => {
    const context: RoutingContext = { ...base, withdrawingChains: [MAINNET] };
    expect(settleableChains(candidateOnBoth, context)).toEqual([DEVNET]);
  });

  it('leaves both chains when nothing is being withdrawn', () => {
    // The control for the case above. Without it, `settleableChains = () => []`
    // and a subtraction that drops everything both pass.
    expect(settleableChains(candidateOnBoth, base)).toEqual([DEVNET, MAINNET]);
  });

  it('rejects with BUYER_WITHDRAWING when it is the only chain', () => {
    // Naming WHY matters more than the rejection: CHAIN_NOT_SETTLEABLE would
    // tell the buyer to fund another chain, and the money is fine — they asked
    // for it back. PAYMENT_INSUFFICIENT_FUNDS would be a different lie.
    const context: RoutingContext = {
      ...base,
      payerChains: [MAINNET],
      defaultChainId: MAINNET,
      withdrawingChains: [MAINNET],
    };

    const result = filterEligible([candidateOnMainnet], FLOOR_ON_BOTH, context);

    expect(result.eligible).toHaveLength(0);
    expect(result.rejected[0].reason).toBe(IneligibilityReason.BUYER_WITHDRAWING);
  });

  it('quotes normally once the request is retracted', () => {
    // The control. `requestWithdraw(0)` retracts in one call, and the gate must
    // reopen — otherwise cancelling is a thing the UI offers and nothing honours.
    const context: RoutingContext = {
      ...base,
      payerChains: [MAINNET],
      defaultChainId: MAINNET,
      withdrawingChains: [],
    };

    expect(filterEligible([candidateOnMainnet], FLOOR_ON_BOTH, context).eligible).toHaveLength(1);
  });

  it('still says CHAIN_NOT_SETTLEABLE when the buyer was never on the candidate chain', () => {
    // Two different facts must not share one label. This buyer is withdrawing —
    // on DEVNET — and the candidate settles on MAINNET, which they cannot pay on
    // at all. The withdrawal is irrelevant to why this candidate was cut, and
    // reporting BUYER_WITHDRAWING would hide a chain they genuinely could fund.
    const context: RoutingContext = {
      ...base,
      payerChains: [DEVNET],
      defaultChainId: DEVNET,
      withdrawingChains: [DEVNET],
    };

    const result = filterEligible([candidateOnMainnet], FLOOR_ON_BOTH, context);

    expect(result.rejected[0].reason).toBe(IneligibilityReason.CHAIN_NOT_SETTLEABLE);
  });

  it('names only the chains that would otherwise have settled', () => {
    // `chainsWithheldForWithdrawal` is the classifier, and it is not
    // `context.withdrawingChains`: a buyer withdrawing on a chain this candidate
    // never offered has nothing withheld from them here.
    const context: RoutingContext = {
      ...base,
      payerChains: [DEVNET, MAINNET],
      withdrawingChains: [DEVNET, MAINNET],
    };

    expect(chainsWithheldForWithdrawal(candidateOnMainnet, context)).toEqual([MAINNET]);
    expect(chainsWithheldForWithdrawal(candidateOnBoth, context)).toEqual([DEVNET, MAINNET]);
  });

  /**
   * The corollary, proved the way `routing-chains.spec.ts` proves the same
   * property for `CHAIN_NOT_SETTLEABLE`: by MECHANISM.
   *
   * Nothing in this codebase reads an `Ineligible` into statistics —
   * `IneligibilityReason` is consumed only inside `domain/routing/` and by the
   * router's own error text — so "never a provider-quality event" holds because
   * statistics, the circuit breaker and `tool_call_records` are all fed from
   * ATTEMPTS, and a withdrawal-rejected candidate is never attempted. There is
   * deliberately no `PROVIDER_QUALITY_REASONS` list: a list nothing reads is a
   * comment with a type annotation, and it would stay green while a future
   * consumer folded rejections into a provider's record anyway.
   */
  it('never dials a provider it withdrawal-rejected, so no quality event is produced', async () => {
    const invoker = new ScriptedInvoker({});
    const harness = buildRouter({
      bindings: [buildBinding('a', { settlementChains: [DEVNET] })],
      providers: [buildProvider('a')],
      stakes: {},
      stakesByChain: { [`a|${DEVNET}`]: usdc(1000) },
      enrolments: [{ providerId: 'a', chainId: DEVNET }],
      invoker,
    });

    const error: AppError | null = await harness.router
      .route({
        toolId: TOOL_ID,
        callId: 'call-1',
        input: { query: 'x' },
        context: {
          payerChains: [DEVNET],
          enabledChains: [DEVNET],
          defaultChainId: DEVNET,
          withdrawingChains: [DEVNET],
        },
      })
      .then(() => null)
      .catch((e: AppError) => e);

    // NOT `PAYMENT_NO_SETTLEABLE_CHAIN`. That error's one useful action is
    // "fund another chain", and this buyer has just asked for their money back
    // from the only chain they have. And NOT `TOOL_NO_ELIGIBLE_BINDING`: the
    // supply is fine, so the agent is told the real reason and who clears it.
    expect(error?.errorCode).toBe(PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING);
    expect(error?.context?.chains).toEqual([DEVNET]);
    expect(error?.message).toMatch(/withdrawal is pending/i);
    expect(error?.message).toMatch(/cancel or complete/i);

    expect(invoker.invocations).toHaveLength(0);
    // And no ceiling token was taken. Shedding debits a provider's declared
    // allowance, and a buyer's cash management must not spend it.
    expect(harness.redis.commands).toEqual([]);
  });
});

/**
 * The other half, and the half the gate is worthless without: something has to
 * SUPPLY `withdrawingChains`.
 *
 * Every case above passes against an `McpToolCallService` that hard-codes `[]`,
 * which is exactly the shape this project's nineteen measured defects took —
 * a test asserting less than its name claims. These cases run the real
 * `tools/call` loop over a real escrow reader and assert on the outcome.
 */
describe('tools/call reads the escrow and refuses a withdrawing buyer', () => {
  const ARGS = { query: 'moon landing' };
  const SCRIPT = { 'binding-provider-a': () => Promise.resolve(ok('forty-two')) };

  const mcp = (escrow: FakeEscrowReader) =>
    buildMcpHarness({
      bindings: [buildBinding('provider-a')],
      providers: [buildProvider('provider-a')],
      invoker: new ScriptedInvoker(SCRIPT),
      escrow,
    });

  it('refuses the call when a withdrawal is standing on the session chain', async () => {
    const escrow = new FakeEscrowReader();
    escrow.withdrawRequested = 5_000_000n;
    const { calls, intents } = mcp(escrow);

    await expect(calls.call(SESSION, 'Search the web', ARGS)).rejects.toMatchObject({
      errorCode: PaymentErrorCode.PAYMENT_WITHDRAWAL_PENDING,
    });

    // The escrow was actually consulted, on the buyer's own account.
    expect(escrow.reads).toContain(SESSION.agentAccount);
    // And the intent was voided rather than left to a sweep.
    expect(intents.transitions).toContain(`→ ${PaymentIntentStatus.VOIDED}`);
  });

  it('serves the same call once the request is retracted', async () => {
    // The control. A harness that refused every call would pass the case above.
    const escrow = new FakeEscrowReader();
    escrow.withdrawRequested = 0n;
    const { calls } = mcp(escrow);

    const outcome = await calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
  });

  it('serves a buyer who has no escrow account at all', async () => {
    // The second control, and the ordinary state of an MCP buyer: they spend the
    // ledger mirror and may never have opened an escrow. `null` is not a
    // withdrawal.
    const escrow = new FakeEscrowReader();
    expect(escrow.withdrawRequested).toBeNull();

    const outcome = await (await mcp(escrow)).calls.call(SESSION, 'Search the web', ARGS);

    expect(outcome.kind).toBe('RESULT');
  });

  it('fails CLOSED when the escrow cannot be read', async () => {
    // The port's own contract: `read` is the one balance read in this codebase
    // that never degrades to a stale mirror. Swallowing this would make
    // `withdrawingChains` default to `[]`, which is the fail-open the field's
    // doc comment forbids. The cost is stated there: a paid MCP call now
    // depends on a chain read where before it touched no chain at all.
    const escrow = new FakeEscrowReader();
    escrow.throws = new Error('rpc unreachable');
    const { calls } = mcp(escrow);

    await expect(calls.call(SESSION, 'Search the web', ARGS)).rejects.toThrow(/rpc unreachable/);
  });
});
