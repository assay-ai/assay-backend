import { Logger } from '@nestjs/common';

import { StandingSlashRecord } from '@database/postgres/repositories/evm-slash-record.repository';
import { ChainErrors } from '@modules/chains/errors/chains.errors';
import {
  EVM_REVOKED_VERIFIER_ALERTS,
  EVM_REVOKED_VERIFIER_REAP_BATCH,
  EvmRevokedVerifierReaper,
} from '@modules/chains/evm/evm-revoked-verifier.reaper';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { Alert, AlertSeverity } from '@shared/alerting';

const CHAIN: ChainId = CHAIN_IDS.ROBINHOOD_TESTNET;
const CONFIG = '0x00000000000000000000000000000000000000cf' as const;
const STAKE = '0x00000000000000000000000000000000000000aa' as const;
const STOLEN = '0x00000000000000000000000000000000000000d1';
const LIVE = '0x00000000000000000000000000000000000000d2';
const PROVIDER_A = '0x00000000000000000000000000000000000000a1';
const PROVIDER_B = '0x00000000000000000000000000000000000000b1';
const NOW = new Date('2026-10-24T12:00:00Z');

const id = (n: number) => n.toString(16).padStart(64, '0');

interface Row extends StandingSlashRecord {
  closedAt: Date | null;
  verifierUnavailable: boolean;
  reapAttempts: number;
  reapLastError: string | null;
}

/** `evm_slash_records`, in memory, with the repository's own semantics. */
class FakeRecords {
  rows: Row[] = [];
  add(n: number, verifier: string, provider: string, reserved = 1_000_000n) {
    this.rows.push({
      requestId: id(n),
      provider,
      verifier,
      reserved,
      closedAt: null,
      verifierUnavailable: false,
      reapAttempts: 0,
      reapLastError: null,
    });
  }
  async standingVerifiers() {
    return [...new Set(this.rows.filter((r) => !r.closedAt).map((r) => r.verifier))].sort();
  }
  async markVerifierUnavailable(_chainId: string, verifier: string) {
    this.rows.filter((r) => r.verifier === verifier).forEach((r) => (r.verifierUnavailable = true));
  }
  async standingByVerifier(_chainId: string, verifier: string, limit: number) {
    return this.rows
      .filter((r) => !r.closedAt && r.verifier === verifier)
      .sort((a, b) => a.reapAttempts - b.reapAttempts)
      .slice(0, limit)
      .map(({ requestId, provider, verifier: v, reserved }) => ({
        requestId,
        provider,
        verifier: v,
        reserved,
      }));
  }
  async markClosed(_chainId: string, ids: readonly string[], at: Date) {
    this.rows
      .filter((r) => ids.includes(r.requestId) && !r.closedAt)
      .forEach((r) => (r.closedAt = at));
  }
  async recordReapFailure(_chainId: string, requestId: string, error: string) {
    const row = this.rows.find((r) => r.requestId === requestId)!;
    row.reapAttempts += 1;
    row.reapLastError = error;
  }
}

/** The chain: `canSign` per key and `slashRecordOf` per request id (1 Pending, 3 Cancelled, 4 Disputed). */
class FakeChain {
  canSign = new Map<string, boolean>();
  status = new Map<string, number>();
  verifierOf = new Map<string, string>();
  async readContract(args: { address: string; functionName: string; args: readonly unknown[] }) {
    if (args.functionName === 'canSign') {
      expect(args.address).toBe(CONFIG);
      return this.canSign.get(String(args.args[0]).toLowerCase()) ?? true;
    }
    expect(args.functionName).toBe('slashRecordOf');
    expect(args.address).toBe(STAKE);
    const requestId = String(args.args[0]).replace(/^0x/, '');
    return {
      provider: PROVIDER_A,
      status: this.status.get(requestId) ?? 1,
      penalty: 1n,
      beneficiary: PROVIDER_B,
      proposedAt: 1n,
      verifier: this.verifierOf.get(requestId) ?? STOLEN,
      executableAt: 1n,
      reserved: 1n,
      capAllowance: 0n,
      applied: 0n,
      executedAt: 0n,
      policy: `0x${'0'.repeat(64)}`,
      disputedAt: 0n,
    };
  }
}

function build() {
  const records = new FakeRecords();
  const chain = new FakeChain();
  const alerts: Alert[] = [];
  const sent: string[][] = [];
  const refuse = new Map<string, unknown>();
  const expirer = {
    expireBatch: async (requests: readonly { requestId: string }[]) => {
      sent.push(requests.map((r) => r.requestId));
      return requests.map((r) => {
        const error = refuse.get(r.requestId);
        if (error) return { ok: false as const, error };
        chain.status.set(r.requestId, 3);
        return {
          ok: true as const,
          result: { signature: '0xtx', cancelledAt: NOW, reason: 'VERIFIER_UNAVAILABLE' as const },
        };
      });
    },
  };
  const rechecked: string[] = [];
  const holds = { recheckAuthority: async (_c: ChainId, p: string) => void rechecked.push(p) };
  const reaper = new EvmRevokedVerifierReaper(
    new Map([[CHAIN, chain]]) as never,
    new Map([[CHAIN, { config: CONFIG, stake: STAKE }]]) as never,
    [CHAIN],
    records as never,
    expirer,
    { emit: async (alert: Alert) => void alerts.push(alert) },
    holds as never,
    () => NOW,
  );
  return { reaper, records, chain, alerts, sent, refuse, rechecked };
}

describe('EvmRevokedVerifierReaper (review 2026-10-24 wave 2 M-2)', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends nothing while every key with standing records can still sign', async () => {
    const { reaper, records, sent, alerts } = build();
    records.add(1, LIVE, PROVIDER_A);
    await expect(reaper.reap()).resolves.toEqual([]);
    expect(sent).toEqual([]);
    expect(alerts).toEqual([]);
    expect(records.rows[0].verifierUnavailable).toBe(false);
  });

  it('releases every standing record of a revoked key, Pending and Disputed, ours and foreign, in batches', async () => {
    const { reaper, records, chain, sent, alerts, rechecked } = build();
    const total = EVM_REVOKED_VERIFIER_REAP_BATCH + 6;
    for (let n = 1; n <= total; n += 1) records.add(n, STOLEN, n % 2 ? PROVIDER_A : PROVIDER_B);
    records.add(1000, LIVE, PROVIDER_A); // another key's record is left alone
    chain.status.set(id(2), 4); // Disputed
    chain.canSign.set(STOLEN, false);

    const [report] = await reaper.reap();
    expect(report).toEqual({
      chainId: CHAIN,
      verifier: STOLEN,
      released: total,
      alreadyClosed: 0,
      failed: 0,
    });
    expect(sent.map((batch) => batch.length)).toEqual([EVM_REVOKED_VERIFIER_REAP_BATCH, 6]);
    expect(sent.flat()).not.toContain(id(1000));
    expect(records.rows.filter((r) => r.verifier === STOLEN).every((r) => r.closedAt)).toBe(true);
    expect(
      records.rows.filter((r) => r.verifier === STOLEN).every((r) => r.verifierUnavailable),
    ).toBe(true);
    expect(records.rows.find((r) => r.verifier === LIVE)?.closedAt).toBeNull();
    expect(new Set(rechecked)).toEqual(new Set([PROVIDER_A, PROVIDER_B]));
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: AlertSeverity.WARN,
        name: EVM_REVOKED_VERIFIER_ALERTS.RELEASING,
      }),
    ]);
  });

  it('is idempotent: a second pass sends nothing', async () => {
    const { reaper, records, chain, sent } = build();
    records.add(1, STOLEN, PROVIDER_A);
    chain.canSign.set(STOLEN, false);
    await reaper.reap();
    await expect(reaper.reap()).resolves.toEqual([]);
    expect(sent).toEqual([[id(1)]]);
  });

  it('closes, without sending, a record somebody else already released', async () => {
    const { reaper, records, chain, sent } = build();
    records.add(1, STOLEN, PROVIDER_A);
    records.add(2, STOLEN, PROVIDER_A);
    chain.status.set(id(1), 3); // the arbiter's cancelSlashBatch got there first
    chain.canSign.set(STOLEN, false);
    const [report] = await reaper.reap();
    expect(report).toMatchObject({ released: 1, alreadyClosed: 1, failed: 0 });
    expect(sent).toEqual([[id(2)]]);
    expect(records.rows.every((r) => r.closedAt)).toBe(true);
  });

  it('keeps a refused record standing, counts it, raises CRITICAL, and retries next pass', async () => {
    const { reaper, records, chain, refuse, alerts } = build();
    records.add(1, STOLEN, PROVIDER_A);
    records.add(2, STOLEN, PROVIDER_A);
    chain.canSign.set(STOLEN, false);
    // A Stake without D-27 refuses before the deadline.
    refuse.set(
      id(1),
      ChainErrors.transactionFailed({
        reason: 'SlashNotExpired',
        customErrorCode: null,
        programErrorName: 'SlashNotExpired',
      }),
    );

    const [report] = await reaper.reap();
    expect(report).toMatchObject({ released: 1, failed: 1 });
    expect(records.rows[0]).toMatchObject({
      closedAt: null,
      reapAttempts: 1,
      reapLastError: 'SlashNotExpired',
    });
    expect(alerts.map((a) => [a.severity, a.name])).toEqual([
      [AlertSeverity.WARN, EVM_REVOKED_VERIFIER_ALERTS.RELEASING],
      [AlertSeverity.CRITICAL, EVM_REVOKED_VERIFIER_ALERTS.STUCK],
    ]);

    refuse.clear();
    const [again] = await reaper.reap();
    expect(again).toMatchObject({ released: 1, failed: 0 });
    expect(records.rows.every((r) => r.closedAt)).toBe(true);
  });

  it('never sends for a record the chain does not attribute to the dead key', async () => {
    const { reaper, records, chain, sent } = build();
    records.add(1, STOLEN, PROVIDER_A);
    chain.verifierOf.set(id(1), LIVE);
    chain.canSign.set(STOLEN, false);
    const [report] = await reaper.reap();
    expect(report).toMatchObject({ released: 0, failed: 1 });
    expect(sent).toEqual([]);
    expect(records.rows[0]).toMatchObject({ closedAt: null, reapLastError: 'VerifierMismatch' });
  });
});
