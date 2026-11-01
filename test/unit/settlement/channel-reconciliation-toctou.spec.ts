import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';
import { ChannelReconciliationService } from '@modules/settlement/services/channel-reconciliation.service';

/**
 * Final review 2026-11-01, backend F1 / ops F3: the reconciler's per-channel
 * check read the DB mirror ONCE and then each lane's chain books one RPC at a
 * time. A lane admitted and settled between the two reads was stopped as
 * DESYNC/RECONCILE (CRITICAL) although DB and chain agree. The lane row is now
 * re-read after the chain read; only a mismatch that still holds stops it.
 */
const ASSET = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac' as never;
const KEY = `0x${'0c'.repeat(32)}`;

function build(
  live: { accepted: bigint; settled: bigint; settling?: boolean },
  chain: () => bigint,
) {
  const snapshot = { ...live };
  const statuses: unknown[][] = [];
  const channels = {
    heldByChannel: jest.fn(async () => [
      {
        channelRowId: 'lane',
        key: KEY,
        settling: false,
        held: 0n,
        settled: snapshot.settled,
        accepted: snapshot.accepted,
      },
    ]),
    findById: jest.fn(async () => ({
      id: 'lane',
      channelKey: KEY,
      lastAcceptedCumulative: live.accepted.toString(),
      settledCumulative: live.settled.toString(),
      settlingTo: live.settling ? '1' : null,
    })),
    setStatus: jest.fn(async (...args: unknown[]) => void statuses.push(args)),
    providerAddresses: async () => [],
    settlementIdentityBreaks: async () => [],
    scanCursor: async () => null,
    setScanCursor: async () => undefined,
  };
  const door = {
    treasury: async () => `0x${'ee'.repeat(20)}`,
    foreignChannelTxs: async () => ({ toBlock: 1n, foreign: [] }),
    readBooks: jest.fn(async (_asset: unknown, key: string) => {
      if (key === `0x${'0'.repeat(64)}`) {
        return { slot: EMPTY_SLOT, unpaid: 0n, totalUnpaid: 0n, held: 0n };
      }
      return { slot: { ...EMPTY_SLOT, settled: chain() }, unpaid: 0n, totalUnpaid: 0n, held: 0n };
    }),
  };
  const intents = { sumChannelHeldOnChain: async () => 0n };
  const service = new ChannelReconciliationService(
    door as never,
    channels as never,
    intents as never,
  );
  return { service, statuses, channels };
}

describe('channel reconciler: snapshot TOCTOU (final review F1 / ops F3)', () => {
  it('does not stop a healthy lane whose settle landed after the mirror snapshot', async () => {
    const live = { accepted: 100n, settled: 100n };
    const { service, statuses } = build(live, () => {
      // Between the snapshot and this RPC: one call admitted (100 → 110), the
      // urgent round settled it on chain and booked it (settled 110).
      live.accepted = 110n;
      live.settled = 110n;
      return 110n;
    });
    const reading = await service.read(ASSET);
    expect(statuses).toEqual([]);
    expect(
      reading.findings.some((f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH),
    ).toBe(false);
  });

  it('still stops a lane whose chain settled above what the fresh row accepted (CRITICAL)', async () => {
    const live = { accepted: 100n, settled: 100n };
    const { service, statuses } = build(live, () => {
      live.accepted = 110n;
      return 150n;
    });
    const reading = await service.read(ASSET);
    expect(statuses).toEqual([['lane', VoucherChannelStatus.DESYNC, 'RECONCILE']]);
    const breach = reading.findings.find(
      (f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH,
    );
    expect(breach?.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(breach?.details).toMatchObject({ accepted: '110' });
  });

  it('a settlement in flight on the fresh row is not judged this pass', async () => {
    const live = { accepted: 100n, settled: 100n, settling: false };
    const { service, statuses } = build(live, () => {
      live.accepted = 200n;
      live.settling = true;
      return 90n;
    });
    const reading = await service.read(ASSET);
    expect(statuses).toEqual([]);
    expect(reading.findings).toEqual([]);
  });

  it('a chain behind the DB (a lagging node) is WARN first, and stops the lane only if it persists', async () => {
    const live = { accepted: 300n, settled: 300n };
    const { service, statuses } = build(live, () => 200n);
    const first = await service.read(ASSET);
    expect(statuses).toEqual([]);
    const lag = first.findings.find(
      (f) => f.code === ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT,
    );
    expect(lag?.severity).toBe(ReconciliationSeverity.WARN);
    expect(
      first.findings.some((f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH),
    ).toBe(false);

    const second = await service.read(ASSET);
    expect(statuses).toEqual([['lane', VoucherChannelStatus.DESYNC, 'RECONCILE']]);
    expect(
      second.findings.find((f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH)
        ?.severity,
    ).toBe(ReconciliationSeverity.CRITICAL);
  });

  it('a lagging read that catches up clears the first sighting', async () => {
    const live = { accepted: 300n, settled: 300n };
    let chain = 200n;
    const { service, statuses } = build(live, () => chain);
    await service.read(ASSET);
    chain = 300n;
    await service.read(ASSET);
    chain = 200n;
    const third = await service.read(ASSET);
    expect(statuses).toEqual([]);
    expect(
      third.findings.some((f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH),
    ).toBe(false);
  });
});
