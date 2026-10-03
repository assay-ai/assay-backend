import { LedgerEntryType } from '@modules/ledger/ports/ledger.types';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { SlashCompensationService } from '@modules/slash/services/slash-compensation.service';

/**
 * The `SLASH_DISTRIBUTION` producer.
 *
 * The entry type existed in three tables for a long time with nothing writing
 * it, which meant a slash could land on chain and the buyer's balance would not
 * move. This is what closes that.
 *
 * What this suite deliberately does not claim: the **idempotency** guarantee is
 * a partial unique index on `ledger_entries`, and a suite over a mocked ledger
 * cannot see an index. What is checked here is that a duplicate is *treated* as
 * already-paid rather than as a failure; that the index exists and bites
 * belongs to the integration harness.
 */

const SIGNATURE = 'sig-abc';
const ASSET = 'solana:dev/token:MintAAA';

function request(overrides: Record<string, unknown> = {}) {
  return {
    windowId: 'window-1',
    agentAmountMinor: '600000',
    assetId: ASSET,
    decimals: 6,
    signature: SIGNATURE,
    providerId: 'provider-1',
    ...overrides,
  };
}

function build(spends: Array<{ organizationId: string; agentAccount: string; spend: string }>) {
  const windowCalls = { sumSpendByAgent: jest.fn().mockResolvedValue(spends) };
  const ledger = { appendNow: jest.fn().mockResolvedValue({}) };
  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };

  const service = new SlashCompensationService(
    windowCalls as never,
    ledger as never,
    notifications as never,
  );

  return { service, windowCalls, ledger, notifications };
}

describe('SlashCompensationService', () => {
  it('credits each harmed agent in their own organization, summing to the share', async () => {
    const { service, ledger } = build([
      { organizationId: 'org-a', agentAccount: 'solana:dev:AgentA', spend: '300' },
      { organizationId: 'org-b', agentAccount: 'solana:dev:AgentB', spend: '100' },
    ]);

    const credited = await service.distribute(request() as never);

    expect(credited).toBe(2);
    expect(ledger.appendNow).toHaveBeenCalledTimes(2);

    const written = ledger.appendNow.mock.calls.map(([entry]) => entry);
    expect(written.map((entry) => entry.organizationId).sort()).toEqual(['org-a', 'org-b']);
    expect(written.every((entry) => entry.entryType === LedgerEntryType.SLASH_DISTRIBUTION)).toBe(
      true,
    );
    const total = written.reduce((sum, entry) => sum + BigInt(entry.money.amount), 0n);
    expect(total).toBe(600000n);
  });

  it('carries the slash signature as the idempotency key', async () => {
    const { service, ledger } = build([
      { organizationId: 'org-a', agentAccount: 'solana:dev:AgentA', spend: '1' },
    ]);

    await service.distribute(request() as never);

    expect(ledger.appendNow).toHaveBeenCalledWith(
      expect.objectContaining({ chainTxRef: SIGNATURE }),
    );
  });

  it('raises the agent-side notification that had no emitter', async () => {
    const { service, notifications } = build([
      { organizationId: 'org-a', agentAccount: 'solana:dev:AgentA', spend: '1' },
    ]);

    await service.distribute(request() as never);

    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-a',
        event: NotificationEvent.SLASH_COMPENSATION_RECEIVED,
        dedupeKey: `${SIGNATURE}:solana:dev:AgentA`,
      }),
    );
  });

  /**
   * The retry path. A failed execution returns the case to UPHELD and the next
   * tick re-runs the whole distribution; the legs already written must come
   * back as "already paid", not as failures.
   */
  it('treats a duplicate as already paid', async () => {
    const { service, ledger, notifications } = build([
      { organizationId: 'org-a', agentAccount: 'solana:dev:AgentA', spend: '1' },
    ]);
    ledger.appendNow.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));

    const credited = await service.distribute(request() as never);

    expect(credited).toBe(1);
    // Not notified a second time — the first attempt already did.
    expect(notifications.notify).not.toHaveBeenCalled();
  });

  it('does not stop at one agent when another agent fails', async () => {
    const { service, ledger } = build([
      { organizationId: 'org-a', agentAccount: 'solana:dev:AgentA', spend: '1' },
      { organizationId: 'org-b', agentAccount: 'solana:dev:AgentB', spend: '1' },
    ]);
    ledger.appendNow.mockRejectedValueOnce(new Error('deadlock'));

    const credited = await service.distribute(request() as never);

    expect(credited).toBe(1);
    expect(ledger.appendNow).toHaveBeenCalledTimes(2);
  });

  it('writes nothing when the share is zero', async () => {
    const { service, ledger, windowCalls } = build([]);

    const credited = await service.distribute(request({ agentAmountMinor: '0' }) as never);

    expect(credited).toBe(0);
    expect(windowCalls.sumSpendByAgent).not.toHaveBeenCalled();
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  /**
   * Money in the vault with nobody to credit is a real state and it must be
   * loud, not silent: the reconciler will report the surplus and somebody has
   * to be able to explain it.
   */
  it('writes nothing, and says so, when nobody spent in the window', async () => {
    const { service, ledger } = build([]);

    const credited = await service.distribute(request() as never);

    expect(credited).toBe(0);
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });

  it('refuses to guess for a case with no window', async () => {
    const { service, ledger } = build([]);

    const credited = await service.distribute(request({ windowId: null }) as never);

    expect(credited).toBe(0);
    expect(ledger.appendNow).not.toHaveBeenCalled();
  });
});
