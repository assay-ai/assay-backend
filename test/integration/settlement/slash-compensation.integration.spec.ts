import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { ReconciliationSeverity } from '@modules/settlement/ports/reconciliation.types';

import {
  SettlementTestContext,
  USDC_ASSET,
  createSettlementTestContext,
} from '../helpers/settlement-test-context';

/**
 * Compensation keeps proof of reserves true, against a real ledger.
 *
 * The whole design rests on one arithmetic claim: the vault gains exactly the
 * agent share on chain, and the `SLASH_DISTRIBUTION` credits sum to exactly the
 * same number, so the reconciler's `vault − liabilities` is unchanged. The unit
 * suite proves the splitter's arithmetic in isolation and the service's
 * branching over a mocked ledger; **neither can see whether Postgres agrees**,
 * because neither writes a row or folds a journal.
 *
 * This does. It writes the credits through `LedgerService` and lets the real
 * reconciler read them back.
 *
 * The second half is the part that matters: a green reconciliation test proves
 * nothing unless the same test goes red when the books are wrong, so the last
 * case credits one unit more than the vault gained and asserts the breach is
 * reported — a gate that cannot fail answers a different question than the
 * one it claims to.
 */
describe('Slash compensation and proof of reserves', () => {
  let context: SettlementTestContext;

  beforeAll(async () => {
    context = await createSettlementTestContext();
  }, 120_000);

  afterAll(async () => {
    await context?.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  /** The agent share of a penalty, as it would arrive from `SlashRecord`. */
  const AGENT_SHARE = 600_000n;

  async function credit(accountId: string, atomic: bigint, signature: string) {
    return context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: accountId as never,
      entryType: LedgerEntryType.SLASH_DISTRIBUTION,
      money: context.usdc(atomic),
      chainTxRef: signature,
    });
  }

  it('leaves the books balanced when the credits sum to what the vault gained', async () => {
    const agentA = context.account('AgentA11111111111111111111111111111111111');
    const agentB = context.account('AgentB11111111111111111111111111111111111');

    await context.fund(agentA, 7_000_000n);
    await context.fund(agentB, 3_000_000n);
    context.setVaultBalance(10_000_000n);

    // Baseline: the books agree before any penalty.
    const before = await context.reconciliation.reconcile(USDC_ASSET);
    expect(before.differenceAtomic).toBe(0n);

    // The chain paid the agent share into the vault...
    context.setVaultBalance(10_000_000n + AGENT_SHARE);

    // ...and the distribution credits it out, 3:1 by spend.
    await credit(agentA, 450_000n, 'sig-balanced');
    await credit(agentB, 150_000n, 'sig-balanced');

    const after = await context.reconciliation.reconcile(USDC_ASSET);

    expect(after.differenceAtomic).toBe(0n);
    expect(after.severity).toBe(ReconciliationSeverity.OK);
    expect(after.findings).toEqual([]);
    expect(after.alerted).toBe(false);
    expect(after.agentLiabilitiesAtomic).toBe(10_000_000n + AGENT_SHARE);
    // The journal fold and the snapshot table agree — a credit written through
    // the service moves both.
    expect(after.snapshotLiabilitiesAtomic).toBe(10_000_000n + AGENT_SHARE);
  });

  /**
   * The interval between the chain landing and the credits being written.
   *
   * The ordering in `SlashCompensationService` is deliberate: the vault is
   * funded first, so the books are only ever wrong in the direction of a
   * **surplus** — never a shortfall. The reverse order would post liabilities
   * against money that had not arrived, which is a breach.
   *
   * Worth knowing, and measured here rather than assumed: a surplus below
   * `RECONCILIATION_SURPLUS_TOLERANCE_UNITS` (one whole unit, $1.00) is
   * tolerated silently. Most penalties are smaller than that — the current
   * ceiling is $1.00 in total, of which the agent share is a fraction — so in
   * practice a distribution in flight is **invisible** to the reconciler. That
   * is the intended outcome, not an oversight, but it means this window cannot
   * be monitored by watching for surplus alerts.
   */
  it('is silent mid-distribution when the share is under the surplus tolerance', async () => {
    const agent = context.account('AgentC11111111111111111111111111111111111');
    await context.fund(agent, 1_000_000n);
    context.setVaultBalance(1_000_000n + AGENT_SHARE);

    const report = await context.reconciliation.reconcile(USDC_ASSET);

    // Positive: the vault holds more than the ledger claims.
    expect(report.differenceAtomic).toBe(AGENT_SHARE);
    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.findings).toEqual([]);
  });

  it('warns about the surplus once it is over the tolerance', async () => {
    const agent = context.account('AgentG11111111111111111111111111111111111');
    const bigShare = 2_500_000n; // $2.50, above the $1.00 tolerance

    await context.fund(agent, 1_000_000n);
    context.setVaultBalance(1_000_000n + bigShare);

    const report = await context.reconciliation.reconcile(USDC_ASSET);

    expect(report.differenceAtomic).toBe(bigShare);
    expect(report.severity).toBe(ReconciliationSeverity.WARN);
    expect(report.findings.map((finding) => finding.code)).toContain('UNEXPLAINED_SURPLUS');
  });

  /**
   * The negative half. Without this the case above is a certificate that could
   * be issued by a reconciler that computes nothing.
   */
  it('reports a breach when the credits exceed what the vault gained', async () => {
    const agent = context.account('AgentD11111111111111111111111111111111111');
    await context.fund(agent, 1_000_000n);

    context.setVaultBalance(1_000_000n + AGENT_SHARE);
    // One unit more than arrived — the dust bug the splitter's exactness
    // property exists to prevent, made real.
    await credit(agent, AGENT_SHARE + 1n, 'sig-overcredited');

    const report = await context.reconciliation.reconcile(USDC_ASSET);

    expect(report.differenceAtomic).toBe(-1n);
    expect(report.severity).not.toBe(ReconciliationSeverity.OK);
    expect(report.alerted).toBe(true);
    expect(context.alerts.emitted.length).toBeGreaterThan(0);
  });

  /**
   * The idempotency guarantee, against the constraint that actually enforces
   * it. A unit test over a mocked ledger cannot see a unique index; this is
   * the only place the retry path is really proved.
   */
  it('refuses to pay the same agent twice for one slash', async () => {
    const agent = context.account('AgentE11111111111111111111111111111111111');
    await context.fund(agent, 1_000_000n);

    await credit(agent, AGENT_SHARE, 'sig-retry');

    await expect(credit(agent, AGENT_SHARE, 'sig-retry')).rejects.toMatchObject({
      code: '23505',
    });
  });

  it('still allows the same agent to be paid for a different slash', async () => {
    const agent = context.account('AgentF11111111111111111111111111111111111');
    await context.fund(agent, 1_000_000n);

    await credit(agent, AGENT_SHARE, 'sig-first');
    await expect(credit(agent, AGENT_SHARE, 'sig-second')).resolves.toBeDefined();

    context.setVaultBalance(1_000_000n + AGENT_SHARE * 2n);
    const report = await context.reconciliation.reconcile(USDC_ASSET);
    expect(report.differenceAtomic).toBe(0n);
  });
});
