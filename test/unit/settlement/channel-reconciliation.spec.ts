import { VoucherChannelStatus } from '@database/postgres/entities/voucher-channel.entity';
import { EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';
import {
  ReconciliationFindingCode,
  ReconciliationSeverity,
} from '@modules/settlement/ports/reconciliation.types';
import { ChannelReconciliationService } from '@modules/settlement/services/channel-reconciliation.service';

const ASSET = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac' as never;
const KEY = `0x${'0c'.repeat(32)}`;

function build(options: {
  books: Record<string, { settled: bigint; h1?: bigint }>;
  global?: { held: bigint; totalUnpaid: bigint };
  mirror: { settled: bigint; accepted: bigint; held: bigint; settling?: boolean };
  mirroredHeld?: bigint;
  unpaidOf?: bigint;
}) {
  const statuses: unknown[] = [];
  const cursor: { value: bigint | null } = { value: null };
  const door = {
    treasury: jest.fn(async () => `0x${'ee'.repeat(20)}`),
    foreignChannelTxs: jest.fn(async () => ({ toBlock: 10n, foreign: [] })),
    readBooks: jest.fn(async (_a: unknown, key: string, to?: string) => {
      if (key === `0x${'0'.repeat(64)}`) {
        return {
          slot: EMPTY_SLOT,
          unpaid: to ? (options.unpaidOf ?? 0n) : 0n,
          totalUnpaid: options.global?.totalUnpaid ?? 0n,
          held: options.global?.held ?? 0n,
        };
      }
      const b = options.books[key];
      return {
        slot: { ...EMPTY_SLOT, settled: b.settled, h1: b.h1 ?? 0n },
        unpaid: 0n,
        totalUnpaid: 0n,
        held: 0n,
      };
    }),
  };
  const channels = {
    heldByChannel: async () => [
      { channelRowId: 'lane', key: KEY, settling: false, ...options.mirror },
    ],
    // The lane row re-read after the chain read (final review F1): unchanged here.
    findById: async () => ({
      id: 'lane',
      lastAcceptedCumulative: options.mirror.accepted.toString(),
      settledCumulative: options.mirror.settled.toString(),
      settlingTo: options.mirror.settling ? options.mirror.accepted.toString() : null,
    }),
    setStatus: async (...args: unknown[]) => void statuses.push(args),
    providerAddresses: async () => [`0x${'bb'.repeat(20)}`],
    settlementIdentityBreaks: async () => [],
    scanCursor: jest.fn(async () => cursor.value),
    setScanCursor: jest.fn(async (_a: unknown, to: bigint) => void (cursor.value = to)),
  };
  const intents = {
    sumChannelHeldOnChain: async () => options.mirroredHeld ?? options.global?.held ?? 0n,
  };
  return {
    service: new ChannelReconciliationService(door as never, channels as never, intents as never),
    statuses,
    door,
    channels,
    cursor,
  };
}

describe('ChannelReconciliationService (v3 §5.7)', () => {
  it('reads channelBooks held and totalUnpaid; clean when the mirror agrees', async () => {
    const { service } = build({
      books: { [KEY]: { settled: 300n, h1: 200n } },
      global: { held: 200n, totalUnpaid: 0n },
      mirror: { settled: 300n, accepted: 400n, held: 200n },
    });
    const reading = await service.read(ASSET);
    expect(reading).toMatchObject({ held: 200n, totalUnpaid: 0n, readable: true });
    expect(reading.findings).toEqual([]);
  });

  it('a chain settled above what was accepted is CRITICAL and stops the channel', async () => {
    const { service, statuses } = build({
      books: { [KEY]: { settled: 500n } },
      mirror: { settled: 300n, accepted: 400n, held: 0n },
    });
    const reading = await service.read(ASSET);
    const breach = reading.findings.find(
      (f) => f.code === ReconciliationFindingCode.CHANNEL_STATE_BREACH,
    );
    expect(breach?.severity).toBe(ReconciliationSeverity.CRITICAL);
    expect(statuses).toContainEqual(['lane', VoucherChannelStatus.DESYNC, 'RECONCILE']);
    // The operator card clears the stop by row id (POST /operator/channels/clear-reconcile).
    expect(breach?.details.channelRowId).toBe('lane');
  });

  it('a chain behind the database is CRITICAL once it persists over two passes', async () => {
    const { service } = build({
      books: { [KEY]: { settled: 100n } },
      mirror: { settled: 300n, accepted: 400n, held: 0n },
    });
    // First pass: a lagging node is suspected (WARN, final review ops F3).
    await service.read(ASSET);
    const reading = await service.read(ASSET);
    expect(reading.findings.map((f) => f.code)).toContain(
      ReconciliationFindingCode.CHANNEL_STATE_BREACH,
    );
  });

  it('warns on bucket/held drift and on set-aside payouts', async () => {
    const { service } = build({
      books: { [KEY]: { settled: 300n, h1: 200n } },
      global: { held: 200n, totalUnpaid: 50n },
      mirror: { settled: 300n, accepted: 300n, held: 100n },
      mirroredHeld: 100n,
      unpaidOf: 50n,
    });
    const codes = (await service.read(ASSET)).findings.map((f) => f.code);
    expect(codes).toContain(ReconciliationFindingCode.HELD_MIRROR_DRIFT);
    expect(codes).toContain(ReconciliationFindingCode.CHANNEL_MIRROR_DRIFT);
    expect(codes).toContain(ReconciliationFindingCode.CHANNEL_UNPAID);
  });

  it('an escrow without the door (before the upgrade) contributes nothing', async () => {
    const service = new ChannelReconciliationService(
      { readBooks: async () => null } as never,
      null,
      null,
    );
    expect(await service.read(ASSET)).toMatchObject({ held: 0n, totalUnpaid: 0n, readable: false });
  });

  it('pages a channel transaction not sent by our redeemer: CRITICAL for a settle, WARN for a collect', async () => {
    const alerts: { severity: string; name: string }[] = [];
    let call = 0;
    const door = {
      readBooks: async () => ({ slot: EMPTY_SLOT, unpaid: 0n, totalUnpaid: 0n, held: 0n }),
      foreignChannelTxs: jest.fn(async () => {
        call += 1;
        return call === 1
          ? {
              toBlock: 100n,
              foreign: [
                { txHash: '0x1', from: '0xstranger', events: ['ChannelSettled'], blockNumber: 99n },
                {
                  txHash: '0x2',
                  from: '0xstranger',
                  events: ['ChannelCollected'],
                  blockNumber: 99n,
                },
              ],
            }
          : { toBlock: 120n, foreign: [] };
      }),
    };
    const service = new ChannelReconciliationService(door as never, null, null, {
      emit: async (a: never) => void alerts.push(a),
    } as never);
    const first = await service.read(ASSET);
    expect(first.findings.map((f) => f.code)).toEqual([
      ReconciliationFindingCode.CHANNEL_FOREIGN_TX,
      ReconciliationFindingCode.CHANNEL_FOREIGN_TX,
    ]);
    // Never a run severity: it must not freeze withdrawals.
    expect(first.findings.every((f) => f.severity === ReconciliationSeverity.WARN)).toBe(true);
    expect(alerts.map((a) => a.severity)).toEqual(['CRITICAL', 'WARN']);
    await service.read(ASSET);
    expect(door.foreignChannelTxs.mock.calls[1]).toEqual([ASSET, 101n, 5_000n]);
  });

  describe('review 2026-10-31 L3/L4', () => {
    it('resumes the foreign scan from the persisted cursor (a restart leaves no gap)', async () => {
      const h = build({
        books: { [KEY]: { settled: 300n, h1: 200n } },
        global: { held: 200n, totalUnpaid: 0n },
        mirror: { settled: 300n, accepted: 400n, held: 200n },
      });
      h.cursor.value = 41n;
      await h.service.read(ASSET);
      expect(h.door.foreignChannelTxs).toHaveBeenCalledWith(ASSET, 42n, 5_000n);
      expect(h.channels.setScanCursor).toHaveBeenCalledWith(ASSET, 10n);
    });

    it('a scan error is a finding, not silence', async () => {
      const h = build({
        books: { [KEY]: { settled: 300n, h1: 200n } },
        global: { held: 200n, totalUnpaid: 0n },
        mirror: { settled: 300n, accepted: 400n, held: 200n },
      });
      h.door.foreignChannelTxs.mockRejectedValueOnce(new Error('rpc down') as never);
      const codes = (await h.service.read(ASSET)).findings.map((f) => f.code);
      expect(codes).toContain(ReconciliationFindingCode.RECONCILIATION_FAILED);
    });

    it('counts the treasury among the addresses whose unpaid makes up totalUnpaid', async () => {
      const h = build({
        books: { [KEY]: { settled: 300n } },
        global: { held: 0n, totalUnpaid: 100n },
        mirror: { settled: 300n, accepted: 300n, held: 0n },
        unpaidOf: 50n,
      });
      const findings = (await h.service.read(ASSET)).findings.filter(
        (f) => f.code === ReconciliationFindingCode.CHANNEL_UNPAID,
      );
      // Provider 50 + treasury 50 = 100: no "unknown address" second finding.
      expect(findings).toHaveLength(1);
      expect(h.door.readBooks).toHaveBeenCalledWith(
        ASSET,
        `0x${'0'.repeat(64)}`,
        `0x${'ee'.repeat(20)}`.toLowerCase(),
      );
    });
  });
});
