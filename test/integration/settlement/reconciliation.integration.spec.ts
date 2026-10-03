import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';
import { AlertSeverity } from '@shared/alerting';

import {
  SettlementTestContext,
  USDC_ASSET,
  createSettlementTestContext,
} from '../helpers/settlement-test-context';

/**
 * The reconciler against a real journal, a real snapshot table and a real
 * history table.
 *
 * The unit specs prove the rules; this proves the rules see what Postgres
 * actually holds — that `sumByEntryType`'s cross-tenant aggregate agrees with
 * what `LedgerService` wrote, that the run row survives its CHECK constraints,
 * and that a journal row inserted behind the ledger's back is caught rather
 * than absorbed.
 */
describe('Reconciliation against a real ledger', () => {
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

  it('is silent and records an OK run when the vault covers the ledger exactly', async () => {
    const agentA = context.account('AgentA11111111111111111111111111111111111');
    const agentB = context.account('AgentB11111111111111111111111111111111111');

    await context.fund(agentA, 7_000_000n);
    await context.fund(agentB, 3_000_000n);
    context.setVaultBalance(10_000_000n);

    const report = await context.reconciliation.reconcile(USDC_ASSET);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.findings).toEqual([]);
    expect(report.alerted).toBe(false);
    expect(context.alerts.emitted).toEqual([]);

    expect(report.agentLiabilitiesAtomic).toBe(10_000_000n);
    expect(report.totalLiabilitiesAtomic).toBe(10_000_000n);
    // The journal fold and the snapshot table agree — the second comparison.
    expect(report.snapshotLiabilitiesAtomic).toBe(10_000_000n);
    expect(report.differenceAtomic).toBe(0n);

    const stored = await context.runs.findLatest(USDC_ASSET);
    expect(stored).toMatchObject({
      severity: 'OK',
      vaultBalance: '10000000',
      totalLiabilities: '10000000',
      difference: '0',
      alerted: false,
    });
    expect(stored?.findings).toEqual([]);
  });

  it('records a run even when nothing is wrong, so silence is provable', async () => {
    context.setVaultBalance(0n);

    await context.reconciliation.reconcile(USDC_ASSET);
    await context.reconciliation.reconcile(USDC_ASSET);
    await context.reconciliation.reconcile(USDC_ASSET);

    const history = await context.runs.findRecent(USDC_ASSET, 10);
    expect(history).toHaveLength(3);
    expect(history.every((run) => run.severity === 'OK')).toBe(true);
  });

  it('carries a hold without changing what the vault must cover', async () => {
    const agent = context.account('AgentC11111111111111111111111111111111111');
    await context.fund(agent, 5_000_000n);
    await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(1_500_000n),
      intentId: '33333333-3333-4333-8333-333333333333',
    });
    context.setVaultBalance(5_000_000n);

    const report = await context.reconciliation.reconcile(USDC_ASSET);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.openHoldsAtomic).toBe(1_500_000n);
    expect(report.totalLiabilitiesAtomic).toBe(5_000_000n);
  });

  /**
   * The planted-discrepancy check. A journal row written straight into
   * Postgres — no service, no balance update — is the shape of the bug this
   * whole item exists to catch: value the ledger believes it owes that never
   * arrived on chain.
   */
  it('catches a journal entry forged behind the ledger, and says by how much', async () => {
    const agent = context.account('AgentD11111111111111111111111111111111111');
    await context.fund(agent, 10_000_000n);
    context.setVaultBalance(10_000_000n);

    // Clean first — this is the baseline the next assertion is read against.
    const before = await context.reconciliation.reconcile(USDC_ASSET);
    expect(before.severity).toBe(ReconciliationSeverity.OK);
    context.alerts.clear();

    await context.forgeJournalEntry({
      accountId: agent,
      entryType: LedgerEntryType.DEPOSIT,
      atomic: 2_500_000n,
    });

    const after = await context.reconciliation.reconcile(USDC_ASSET);

    expect(after.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(after.alerted).toBe(true);
    expect(after.totalLiabilitiesAtomic).toBe(12_500_000n);
    expect(after.differenceAtomic).toBe(-2_500_000n);

    const codes = after.findings.map((finding) => finding.code);
    expect(codes).toContain(ReconciliationFindingCode.RESERVES_BREACH);
    // And the second comparison catches it independently: the snapshot was
    // never updated, so it still says 10,000,000.
    expect(codes).toContain(ReconciliationFindingCode.SNAPSHOT_DRIFT);
    expect(after.snapshotLiabilitiesAtomic).toBe(10_000_000n);

    const breach = context.alerts.emitted.find((alert) => alert.name === 'reserves_breach');
    expect(breach?.severity).toBe(AlertSeverity.CRITICAL);
    expect(breach?.details).toMatchObject({
      vaultBalance: '10000000',
      totalLiabilities: '12500000',
      shortfall: '2500000',
    });

    const stored = await context.runs.findLatest(USDC_ASSET);
    expect(stored).toMatchObject({ severity: 'CRITICAL', difference: '-2500000', alerted: true });
  });

  it('freezes withdrawals after a breach and unfreezes when the books agree again', async () => {
    const agent = context.account('AgentE11111111111111111111111111111111111');
    await context.fund(agent, 10_000_000n);
    context.setVaultBalance(1_000_000n);

    await context.reconciliation.reconcile(USDC_ASSET);
    await expect(context.reconciliation.isFrozen(USDC_ASSET)).resolves.toBe(true);

    // The vault is topped up to cover the liability; the next pass clears it.
    context.setVaultBalance(10_000_000n);
    await context.reconciliation.reconcile(USDC_ASSET);
    await expect(context.reconciliation.isFrozen(USDC_ASSET)).resolves.toBe(false);
  });

  it('folds a settled call into provider and platform books without moving the total', async () => {
    const agent = context.account('AgentF11111111111111111111111111111111111');
    const provider = context.account('Prov1der111111111111111111111111111111111');

    await context.fund(agent, 1_000_000n);
    const hold = await context.ledger.createHold({
      organizationId: context.organizationId,
      accountId: agent,
      money: context.usdc(10_000n),
      intentId: '44444444-4444-4444-8444-444444444444',
    });
    await context.ledger.commitHold(context.organizationId, hold.id);
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: provider,
      entryType: LedgerEntryType.PROVIDER_CREDIT,
      money: context.usdc(9_000n),
    });
    await context.ledger.appendNow({
      organizationId: context.organizationId,
      accountId: 'platform:fees',
      entryType: LedgerEntryType.PLATFORM_FEE,
      money: context.usdc(1_000n),
    });

    context.setVaultBalance(1_000_000n);
    const report = await context.reconciliation.reconcile(USDC_ASSET);

    expect(report.severity).toBe(ReconciliationSeverity.OK);
    expect(report.agentLiabilitiesAtomic).toBe(990_000n);
    expect(report.providerPayableAtomic).toBe(9_000n);
    expect(report.platformFeesAtomic).toBe(1_000n);
    expect(report.totalLiabilitiesAtomic).toBe(1_000_000n);
  });
});
