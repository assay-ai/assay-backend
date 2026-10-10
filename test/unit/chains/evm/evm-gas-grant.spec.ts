import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

import { Alert, AlertPort } from '@shared/alerting';
import { EscrowChainBalance } from '@modules/ledger/ports/escrow-balance-reader.port';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import {
  EVM_GAS_GRANT_MAX_WEI_ENV,
  EVM_GAS_GRANT_DAILY_MAX_WEI_ENV,
  EVM_GAS_GRANT_RESERVATION_LEASE_MS,
  EvmGasGrantService,
  GasGrantRefusal,
  parseGasGrantCaps,
} from '@modules/chains/evm/evm-gas-grant.service';
import {
  EvmRelayResult,
  EvmRelayedCall,
  EvmRelayerPort,
  EvmValueTransfer,
} from '@modules/chains/evm/ports/evm-relayer.port';
import { MoneyUtil } from '@shared/utils/money.util';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const BUYER = `${CHAIN}:0x5B38Da6a701c568545dCfcB03FcB875f56beddC4` as AccountId;
const ORGANIZATION = '11111111-1111-4111-8111-111111111111';

const DEPLOYMENT: EvmDeployment = {
  chainId: CHAIN,
  config: '0x1111111111111111111111111111111111111111',
  stake: '0x2222222222222222222222222222222222222222',
  escrow: '0x3333333333333333333333333333333333333333',
  asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  // Both are fields of `EvmDeployment`; neither is read on this path.
  escrowImplementation: '0x8888888888888888888888888888888888888888',
  admin: '0x9999999999999999999999999999999999999999',
};

const NOW_SECONDS = 1_800_000_000;
const ESTIMATED_GAS = 60_000n;
const FEE_PER_GAS = 100_000_000n; // 0.1 gwei
/** `estimateGas × maxFeePerGas × 1.2` — the whole formula, written out once. */
const EXPECTED_WEI = (ESTIMATED_GAS * FEE_PER_GAS * 12n) / 10n;

const CAPS = {
  perGrantMaxWei: EXPECTED_WEI * 4n,
  dailyMaxWei: EXPECTED_WEI * 10n,
  relayerFloatLowWaterWei: EXPECTED_WEI * 5n,
};

/** A grant ledger over a Map, with no unique index — which is the point of the integration test. */
class FakeGrants {
  readonly rows: { organizationId: string; accountId: string; wei: string; hash: string }[] = [];

  /**
   * The reservation table, **taught to refuse what Postgres refuses**.
   *
   * A fake that simply said `claimed: true` would let every case below pass
   * against a service that never claimed anything — which is how a regression
   * suite once stayed green against unfixed code. So the conflict and the lease are
   * modelled here, and the genuine two-process interleave is proved against the
   * real constraint in `evm-gas-grants.integration.spec.ts`.
   */
  readonly reservations = new Map<string, number>();
  /** The fake's own clock for the lease. `NOW_SECONDS` unless a case moves it. */
  reservationNow = NOW_SECONDS * 1000;

  async hasGranted(accountId: string): Promise<boolean> {
    return this.rows.some((row) => row.accountId === accountId);
  }

  async reserveGrant(reservation: {
    organizationId: string;
    chainId: string;
    accountId: string;
    leaseMs: number;
  }): Promise<{ claimed: boolean; takenOver: boolean }> {
    const held = this.reservations.get(reservation.accountId);
    if (held !== undefined && held >= this.reservationNow - reservation.leaseMs) {
      return { claimed: false, takenOver: false };
    }
    this.reservations.set(reservation.accountId, this.reservationNow);
    return { claimed: true, takenOver: held !== undefined };
  }

  async releaseGrantReservation(accountId: string): Promise<void> {
    this.reservations.delete(accountId);
  }

  async grantedWeiSince(): Promise<bigint> {
    return this.rows.reduce((total, row) => total + BigInt(row.wei), 0n);
  }

  async insert(row: {
    organizationId: string;
    accountId: string;
    wei: string;
    transactionHash: string;
  }): Promise<void> {
    this.rows.push({
      organizationId: row.organizationId,
      accountId: row.accountId,
      wei: row.wei,
      hash: row.transactionHash,
    });
  }
}

describe('EvmGasGrantService', () => {
  let escrow: {
    withdrawRequested: bigint;
    withdrawAvailableAt: number;
  };
  let buyerBalance: bigint;
  let relayerBalance: bigint;
  let feePerGas: bigint;
  /**
   * The CHAIN's clock and this PROCESS's, held apart on purpose.
   *
   * They were one number while control 2 read `Date.now()`. Splitting them is
   * what lets a case move exactly one of the two — see the pair of cases under
   * "the maturity gate reads the chain's clock".
   */
  let chainSeconds: bigint;
  let serverSeconds: number;
  let grants: FakeGrants;
  let sendValue: jest.Mock<Promise<EvmRelayResult>, [EvmValueTransfer]>;
  let sendCall: jest.Mock<Promise<EvmRelayResult>, [EvmRelayedCall]>;
  let alerts: { emit: jest.Mock<Promise<void>, [Alert]> };
  let service: EvmGasGrantService;

  const reading = (): EscrowChainBalance => ({
    balance: MoneyUtil.of('1000000', ASSET as AssetId, 6),
    seqHigh: 0n,
    withdrawRequested: escrow.withdrawRequested,
    withdrawAvailableAt: escrow.withdrawAvailableAt,
    maxVoucherAmount: 0n,
    maxPerWindow: 0n,
    spentInWindow: 0n,
    windowStartedAt: 0,
    observedAt: new Date(NOW_SECONDS * 1000),
  });

  beforeEach(() => {
    // A buyer with a MATURED withdrawal and no ETH. Every case below violates
    // exactly one thing about this fixture, so no case can pass for another's
    // reason.
    escrow = { withdrawRequested: 5_000_000n, withdrawAvailableAt: NOW_SECONDS - 60 };
    chainSeconds = BigInt(NOW_SECONDS);
    serverSeconds = NOW_SECONDS;
    buyerBalance = 0n;
    relayerBalance = CAPS.relayerFloatLowWaterWei * 100n;
    feePerGas = FEE_PER_GAS;
    grants = new FakeGrants();

    sendValue = jest.fn(async (_transfer: EvmValueTransfer) => ({
      hash: '0xaa'.padEnd(66, 'b'),
      status: 'SUCCESS' as const,
      revertReason: null,
      gasUsed: 21_000n,
      blockNumber: 1n,
    }));
    sendCall = jest.fn();
    alerts = { emit: jest.fn(async (_alert: Alert) => undefined) };

    const relayer: EvmRelayerPort = {
      name: 'fake',
      address: async () => `${CHAIN}:0x9999999999999999999999999999999999999999` as AccountId,
      balanceWei: async () => relayerBalance,
      sendCall,
      sendValue,
    };

    service = new EvmGasGrantService(
      grants as never,
      { read: async () => reading() } as never,
      relayer,
      new Map([
        [
          CHAIN as ChainId,
          {
            estimateGas: async () => ESTIMATED_GAS,
            estimateFeesPerGas: async () => ({
              maxFeePerGas: feePerGas,
              maxPriorityFeePerGas: feePerGas / 10n,
            }),
            getBalance: async () => buyerBalance,
            getBlock: async () => ({ timestamp: chainSeconds }),
          },
        ],
      ]),
      new Map([[CHAIN as ChainId, DEPLOYMENT]]),
      CAPS,
      alerts as unknown as AlertPort,
      { now: () => serverSeconds * 1000 },
    );
  });

  // ── The grant ────────────────────────────────────────────────────────────

  it('funds exactly one withdraw for a buyer with a matured request and no ETH', async () => {
    const outcome = await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(outcome.kind).toBe('GRANTED');
    if (outcome.kind !== 'GRANTED') return;
    // "Exactly the gas for one withdraw": the estimate, times the fee, times a
    // small margin — never a round number somebody liked.
    expect(outcome.wei).toBe(EXPECTED_WEI);
    expect(outcome.wei).toBe((ESTIMATED_GAS * FEE_PER_GAS * 12n) / 10n);
  });

  it('estimates the gas for `withdraw` FROM the buyer, TO the escrow', async () => {
    // A grant computed against some other call is a number with no relationship
    // to what the buyer has to send.
    const estimateGas = jest.fn(async () => ESTIMATED_GAS);
    service = rebuild({ estimateGas });

    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(estimateGas).toHaveBeenCalledWith({
      account: '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4',
      to: '0x3333333333333333333333333333333333333333',
      // `withdraw()` — selector `0x3ccfd60b`, pinned against the four-byte
      // keccak of the signature rather than recomputed here.
      data: '0x3ccfd60b',
      value: 0n,
    });
  });

  it("sends the value to the BUYER, on the buyer's own chain", async () => {
    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(sendValue).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: CHAIN, to: BUYER, wei: EXPECTED_WEI }),
    );
  });

  it('records the grant against the buyer, the chain and the transaction', async () => {
    const outcome = await service.grantWithdrawGas(ORGANIZATION, BUYER);
    if (outcome.kind !== 'GRANTED') throw new Error('expected a grant');

    expect(grants.rows).toEqual([
      {
        organizationId: ORGANIZATION,
        accountId: BUYER,
        wei: EXPECTED_WEI.toString(),
        hash: outcome.hash,
      },
    ]);
  });

  // ── The six refusals ─────────────────────────────────────────────────────

  it('grants once per address, EVER', async () => {
    await service.grantWithdrawGas(ORGANIZATION, BUYER);
    const second = await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(second).toEqual({ kind: 'REFUSED', reason: GasGrantRefusal.ALREADY_GRANTED });
    expect(sendValue).toHaveBeenCalledTimes(1);
  });

  it('refuses a buyer who never asked to withdraw', async () => {
    // The grant is for an exit that is ready, not for a buyer who might want
    // one. Anything looser is a faucet.
    escrow.withdrawRequested = 0n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.NO_MATURED_WITHDRAWAL,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it('refuses a buyer whose withdrawal has not MATURED yet', async () => {
    // The half a `withdrawRequested > 0n` check alone would miss. The request
    // stands; `withdraw()` would revert `WithdrawNotYetAvailable`, and the ETH
    // would sit in an address that cannot use it for an hour.
    escrow.withdrawRequested = 5_000_000n;
    escrow.withdrawAvailableAt = NOW_SECONDS + 60;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.NO_MATURED_WITHDRAWAL,
    });
  });

  it('grants at the exact second the CHAIN reaches withdrawAvailableAt', async () => {
    // The boundary, and the control for the two cases above: `>` instead of
    // `>=` would refuse a buyer whose hour is up to the second. The ruler is the
    // chain's `block.timestamp`, so the boundary is stated against that.
    chainSeconds = BigInt(NOW_SECONDS);
    escrow.withdrawAvailableAt = NOW_SECONDS;

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');
  });

  // ── The maturity gate reads the CHAIN's clock ────────────────────────────
  //
  // `X402Escrow.withdraw()` is `if (block.timestamp < e.withdrawAvailableAt)
  // revert WithdrawNotYetAvailable()`. These two cases move ONE of the two
  // clocks each and disagree about the answer, so neither can pass for the
  // other's reason and neither passes against `Date.now()`.

  it("grants when the CHAIN has matured and this process's clock has not", async () => {
    // The measured case: on the local fork `getBlock` and `Date.now()` were
    // 4,418 seconds apart. The contract would pay this withdrawal; a wall-clock
    // gate refused it and spent none of the once-ever budget saying so.
    escrow.withdrawAvailableAt = NOW_SECONDS - 60;
    chainSeconds = BigInt(NOW_SECONDS);
    serverSeconds = NOW_SECONDS - 4_418;

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');
  });

  it('refuses when the CHAIN has not matured, however far ahead this process runs', async () => {
    // The other direction, and the expensive one: a server clock running ahead
    // would fund an address whose `withdraw()` still reverts, burning the
    // once-ever budget on gas that cannot be used for another hour.
    escrow.withdrawAvailableAt = NOW_SECONDS + 60;
    chainSeconds = BigInt(NOW_SECONDS);
    serverSeconds = NOW_SECONDS + 4_418;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.NO_MATURED_WITHDRAWAL,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it("still measures the DAILY WINDOW on the server clock, not the chain's", async () => {
    // The half that did NOT move, and the reason it must not: `grantedWeiSince`
    // compares against `evm_gas_grants.created_at`, which Postgres stamps from
    // the server's clock. Handing it a chain timestamp would compare two
    // unrelated rulers and silently widen or void the daily cap.
    const grantedWeiSince = jest.spyOn(grants, 'grantedWeiSince');
    serverSeconds = NOW_SECONDS - 4_418;
    chainSeconds = BigInt(NOW_SECONDS);

    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(grantedWeiSince).toHaveBeenCalledWith(
      new Date((NOW_SECONDS - 4_418) * 1000 - 24 * 60 * 60 * 1000),
    );
  });

  it('refuses a buyer who has no escrow at all', async () => {
    service = rebuild({ escrowReading: null });

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.NO_MATURED_WITHDRAWAL,
    });
  });

  it('refuses a buyer who already has enough gas', async () => {
    buyerBalance = ESTIMATED_GAS * FEE_PER_GAS * 10n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.BUYER_HAS_GAS,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it('still grants to a buyer holding almost, but not quite, one withdraw', async () => {
    // The control for the case above. A dust balance is not an exit.
    buyerBalance = ESTIMATED_GAS * FEE_PER_GAS - 1n;

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');
  });

  it('refuses when one withdraw would cost more than the per-grant cap', async () => {
    // A gas spike must make the grant refuse, not make it expensive. The cap is
    // configuration; the estimate is the chain's.
    feePerGas = FEE_PER_GAS * 100n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.ABOVE_PER_GRANT_CAP,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it("refuses when today's grants already reached the daily cap", async () => {
    // Ten grants' worth is the cap; the fixture has already spent it.
    grants.rows.push({
      organizationId: ORGANIZATION,
      accountId: `${CHAIN}:0x0000000000000000000000000000000000000001`,
      wei: CAPS.dailyMaxWei.toString(),
      hash: '0xdead',
    });

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.DAILY_CAP_REACHED,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it('counts THIS grant against the daily cap, not just the ones before it', async () => {
    // `sum < cap` admits a grant that takes the total past it. The cap has to
    // bound the total AFTER the grant, or the real ceiling is `cap + one grant`.
    grants.rows.push({
      organizationId: ORGANIZATION,
      accountId: `${CHAIN}:0x0000000000000000000000000000000000000001`,
      wei: (CAPS.dailyMaxWei - EXPECTED_WEI + 1n).toString(),
      hash: '0xdead',
    });

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.DAILY_CAP_REACHED,
    });
  });

  it('refuses when the relayer float is at or below the low-water mark', async () => {
    // The float pays for redemptions too. A grant that empties it stops every
    // provider getting paid, which is a worse failure than one buyer waiting.
    relayerBalance = CAPS.relayerFloatLowWaterWei;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.RELAYER_FLOAT_LOW,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  it('refuses when the grant itself would take the float below the mark', async () => {
    // `balance > lowWaterMark` alone passes here and leaves the relayer under
    // its own floor the moment the transfer lands.
    relayerBalance = CAPS.relayerFloatLowWaterWei + EXPECTED_WEI - 1n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.RELAYER_FLOAT_LOW,
    });
  });

  it('grants when the float clears the mark by exactly the grant', async () => {
    // The control for the two above.
    relayerBalance = CAPS.relayerFloatLowWaterWei + EXPECTED_WEI;

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');
  });

  // ── The order of the refusals ────────────────────────────────────────────

  it('reports ALREADY_GRANTED ahead of every other refusal', async () => {
    // Cheapest and most specific first, so the refusal a buyer sees names the
    // real reason. A buyer already funded, with no request and no float behind
    // them, is told the one fact that will never change.
    await service.grantWithdrawGas(ORGANIZATION, BUYER);
    escrow.withdrawRequested = 0n;
    relayerBalance = 0n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.ALREADY_GRANTED,
    });
  });

  it('reports NO_MATURED_WITHDRAWAL ahead of BUYER_HAS_GAS', async () => {
    escrow.withdrawRequested = 0n;
    buyerBalance = ESTIMATED_GAS * FEE_PER_GAS * 10n;

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.NO_MATURED_WITHDRAWAL,
    });
  });

  // ── The durable reservation ──────────────────────────────────────────────
  //
  // The bound is the unique index on `evm_gas_grants.account_id`, and it can
  // only settle a race AFTER both processes have sent, because a grant row
  // needs a transaction hash. `evm_gas_grant_reservations` is what decides WHO
  // sends. These cases are about the lifecycle; the genuine two-process
  // interleave is in `evm-gas-grants.integration.spec.ts`, against the real
  // constraint.

  it('refuses GRANT_IN_FLIGHT while another attempt holds the reservation', async () => {
    grants.reservations.set(BUYER, NOW_SECONDS * 1000);

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.GRANT_IN_FLIGHT,
    });
    // The point of the whole control: nothing was spent.
    expect(sendValue).not.toHaveBeenCalled();
    // And the once-ever budget is intact — GRANT_IN_FLIGHT is transient, and
    // reporting it as ALREADY_GRANTED would tell a buyer their one chance is
    // gone.
    expect(grants.rows).toHaveLength(0);
  });

  it('claims the reservation only AFTER every free refusal', async () => {
    // A reservation taken earlier is held by a request that then refuses for a
    // cap, locking that address out for a whole lease for nothing.
    relayerBalance = CAPS.relayerFloatLowWaterWei;

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('REFUSED');
    expect(grants.reservations.size).toBe(0);
  });

  it('gives the reservation back once the grant is recorded', async () => {
    // The grants index is the bound from then on. A reservation left behind
    // would make the next reader think an attempt is still in flight.
    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');

    expect(grants.reservations.size).toBe(0);
  });

  it('gives the reservation back when the CHAIN refuses the transfer', async () => {
    // A receipt came back and nothing was funded, so the buyer may retry at
    // once rather than waiting out a lease.
    sendValue.mockResolvedValue({
      hash: '0xfa'.padEnd(66, 'c'),
      status: 'REVERTED',
      revertReason: 'UNKNOWN_REVERT:0x00000000',
      gasUsed: 0n,
      blockNumber: 1n,
    });

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('REFUSED');
    expect(grants.reservations.size).toBe(0);
  });

  it('KEEPS the reservation when the send throws and the outcome is unknown', async () => {
    // The asymmetry that matters. An RPC that stopped answering does not mean
    // nothing was sent; releasing on "we did not hear" is how a retry funds an
    // address twice. The lease expiring is the slower, safer version.
    sendValue.mockRejectedValue(new Error('socket hang up'));

    await expect(service.grantWithdrawGas(ORGANIZATION, BUYER)).rejects.toThrow(/socket hang up/);

    expect(grants.reservations.get(BUYER)).toBe(NOW_SECONDS * 1000);
  });

  it('takes over a reservation older than the lease, and says so', async () => {
    // Without this a holder that died between claiming and recording locks the
    // buyer out of the grant FOREVER — a worse failure, and a permanent one.
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    grants.reservations.set(BUYER, NOW_SECONDS * 1000 - EVM_GAS_GRANT_RESERVATION_LEASE_MS - 1);

    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');

    // A takeover is never routine: it means an earlier attempt never finished,
    // and the lease is not evidence that its send is over.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('took over a reservation'));
    logged.mockRestore();
  });

  it('does NOT take over one that is a millisecond inside the lease', async () => {
    // The boundary, and the control for the case above: an off-by-one here is a
    // lease that does not hold.
    grants.reservations.set(BUYER, NOW_SECONDS * 1000 - EVM_GAS_GRANT_RESERVATION_LEASE_MS);

    expect(await service.grantWithdrawGas(ORGANIZATION, BUYER)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.GRANT_IN_FLIGHT,
    });
    expect(sendValue).not.toHaveBeenCalled();
  });

  // ── The alert ────────────────────────────────────────────────────────────

  it('alerts on every grant, with the address and the amount', async () => {
    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(alerts.emit).toHaveBeenCalledTimes(1);
    const [alert] = alerts.emit.mock.calls[0];
    expect(alert.name).toBe('evm_gas_grant');
    expect(alert.dedupeKey).toContain(BUYER);
    expect(alert.details).toEqual(
      expect.objectContaining({ account: BUYER, wei: EXPECTED_WEI.toString() }),
    );
  });

  it('does not alert on a refusal', async () => {
    // The alert says "the float moved". A refusal is the control working.
    escrow.withdrawRequested = 0n;

    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(alerts.emit).not.toHaveBeenCalled();
  });

  it('still records the grant when the alert throws', async () => {
    // The money has already left. Losing the ROW because the alerting channel
    // is down would re-open the once-ever bound.
    alerts.emit.mockRejectedValue(new Error('telegram down'));

    const outcome = await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(outcome.kind).toBe('GRANTED');
    expect(grants.rows).toHaveLength(1);
  });

  // ── The structural guarantee ─────────────────────────────────────────────

  it('CANNOT move USDG — it sends value, and value has no calldata', async () => {
    // Structural, not behavioural. `sendValue` takes {chainId, to, wei,
    // purpose}; there is no field a token transfer could be put in, so no
    // reviewer has to check that nobody did.
    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    const [transfer] = sendValue.mock.calls[0];
    expect(Object.keys(transfer).sort()).toEqual(['chainId', 'purpose', 'to', 'wei']);
    expect(sendCall).not.toHaveBeenCalled();
  });

  it('reaches sendCall from nowhere in this service', () => {
    // The source-level half: `sendCall` is the only door with calldata, and this
    // class must not name it. A `data` field added to `EvmValueTransfer` "for
    // symmetry" removes the control entirely and nothing else replaces it.
    const source = readFileSync(
      join(__dirname, '../../../../src/modules/chains/evm/evm-gas-grant.service.ts'),
      'utf8',
    );

    expect(source).toContain('sendValue');
    expect(source).not.toMatch(/\.sendCall\b/);
  });

  // ── A failed send is not a grant ─────────────────────────────────────────

  it('records nothing when the transfer reverts', async () => {
    sendValue.mockResolvedValue({
      hash: '0xfa'.padEnd(66, 'c'),
      status: 'REVERTED',
      revertReason: 'UNKNOWN_REVERT:0x00000000',
      gasUsed: 0n,
      blockNumber: 1n,
    });

    const outcome = await service.grantWithdrawGas(ORGANIZATION, BUYER);

    expect(outcome.kind).toBe('REFUSED');
    // And the address is NOT burned: nothing was funded, so the once-ever budget
    // must still be there.
    expect(grants.rows).toHaveLength(0);
    expect(await grants.hasGranted(BUYER)).toBe(false);
  });

  // ── The reading door, and the chain ──────────────────────────────────────

  it('refuses a mixed-case address whose EIP-55 checksum does not verify', async () => {
    // The recurring bug on this branch: CAIP-10's grammar is chain-agnostic, so
    // a broken checksum satisfies `parseAccountId`, and viem's non-strict
    // `getAddress` downstream REPAIRS it. Here that would fund an address nobody
    // verified and file the row under the repaired spelling — so the once-ever
    // index would not recognise the original, and the same buyer could be funded
    // again under the correct one.
    const typo = `${CHAIN}:0x5B38Da6a701c568545dCfcB03FcB875f56beddC5` as AccountId;

    await expect(service.grantWithdrawGas(ORGANIZATION, typo)).rejects.toThrow();
    expect(sendValue).not.toHaveBeenCalled();
  });

  it('accepts the correctly checksummed form of that same address', async () => {
    // The control. The two inputs differ in exactly one character.
    expect((await service.grantWithdrawGas(ORGANIZATION, BUYER)).kind).toBe('GRANTED');
  });

  it('refuses an account on a chain this deployment does not serve', async () => {
    const elsewhere =
      `${CHAIN_IDS.ROBINHOOD_MAINNET}:0x5B38Da6a701c568545dCfcB03FcB875f56beddC4` as AccountId;

    await expect(service.grantWithdrawGas(ORGANIZATION, elsewhere)).rejects.toThrow();
    expect(sendValue).not.toHaveBeenCalled();
  });

  // ── A leaked relayer key ─────────────────────────────────────────────────

  it('can only ever pay the address it was asked about', async () => {
    // The binding threat model: a full leak of every env-held key must not lose
    // user money. The relayer key is what a leak would take, and everything it
    // can do through THIS class is send ETH to an address that (a) is a real
    // EIP-55 address on a served chain, (b) has a matured withdrawal standing,
    // and (c) has never been funded. The recipient is never a parameter of the
    // grant's own choosing — it is the account under examination.
    await service.grantWithdrawGas(ORGANIZATION, BUYER);

    const [transfer] = sendValue.mock.calls[0];
    expect(transfer.to).toBe(BUYER);
    // …and the money that moves is ETH the platform owns, never the buyer's
    // USDG: `withdraw()` pays `msg.sender`, and `msg.sender` here is the buyer.
    expect(transfer.wei).toBeLessThanOrEqual(CAPS.perGrantMaxWei);
  });

  // ── The caps have no defaults ────────────────────────────────────────────

  describe('parseGasGrantCaps', () => {
    const good = {
      [EVM_GAS_GRANT_MAX_WEI_ENV]: '2000000000000000',
      [EVM_GAS_GRANT_DAILY_MAX_WEI_ENV]: '50000000000000000',
      floatLowWaterWei: '10000000000000000',
    };

    it('reads both caps and the float floor', () => {
      expect(
        parseGasGrantCaps(
          good[EVM_GAS_GRANT_MAX_WEI_ENV],
          good[EVM_GAS_GRANT_DAILY_MAX_WEI_ENV],
          good.floatLowWaterWei,
        ),
      ).toEqual({
        perGrantMaxWei: 2_000_000_000_000_000n,
        dailyMaxWei: 50_000_000_000_000_000n,
        relayerFloatLowWaterWei: 10_000_000_000_000_000n,
      });
    });

    it.each([
      [
        'the per-grant cap',
        undefined,
        good[EVM_GAS_GRANT_DAILY_MAX_WEI_ENV],
        good.floatLowWaterWei,
      ],
      ['the daily cap', good[EVM_GAS_GRANT_MAX_WEI_ENV], undefined, good.floatLowWaterWei],
      [
        'the float floor',
        good[EVM_GAS_GRANT_MAX_WEI_ENV],
        good[EVM_GAS_GRANT_DAILY_MAX_WEI_ENV],
        undefined,
      ],
    ])('fails the boot when %s is unset', (_name, perGrant, daily, float) => {
      // An unset cap is a boot failure, not an unlimited faucet. A `?? DEFAULT`
      // here is a faucet whose size nobody chose.
      expect(() => parseGasGrantCaps(perGrant, daily, float)).toThrow(/EVM_/);
    });

    it.each(['0', '-1', 'lots', '1.5', '0x10', ''])('refuses %p', (value) => {
      expect(() =>
        parseGasGrantCaps(value, good[EVM_GAS_GRANT_DAILY_MAX_WEI_ENV], good.floatLowWaterWei),
      ).toThrow();
    });

    it('refuses a daily cap below the per-grant cap', () => {
      // Otherwise the first grant of the day is always refused and the feature
      // is off in a way nothing reports.
      expect(() => parseGasGrantCaps('100', '99', '10')).toThrow(/daily/i);
    });

    it('never quotes the value it failed to parse', () => {
      // `docs/architecture.md` §"Signing Keys" rule 6. These are not secrets, and
      // the rule is about the habit: an error message that echoes its input is
      // one config key away from echoing a key.
      expect(() => parseGasGrantCaps('sekrit', '1', '1')).toThrow(
        expect.objectContaining({ message: expect.not.stringContaining('sekrit') }),
      );
    });
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function rebuild(options: {
    estimateGas?: () => Promise<bigint>;
    escrowReading?: EscrowChainBalance | null;
  }): EvmGasGrantService {
    const relayer: EvmRelayerPort = {
      name: 'fake',
      address: async () => `${CHAIN}:0x9999999999999999999999999999999999999999` as AccountId,
      balanceWei: async () => relayerBalance,
      sendCall,
      sendValue,
    };

    return new EvmGasGrantService(
      grants as never,
      {
        read: async () => (options.escrowReading === undefined ? reading() : options.escrowReading),
      } as never,
      relayer,
      new Map([
        [
          CHAIN as ChainId,
          {
            estimateGas: options.estimateGas ?? (async () => ESTIMATED_GAS),
            estimateFeesPerGas: async () => ({
              maxFeePerGas: feePerGas,
              maxPriorityFeePerGas: feePerGas / 10n,
            }),
            getBalance: async () => buyerBalance,
            getBlock: async () => ({ timestamp: chainSeconds }),
          },
        ],
      ]),
      new Map([[CHAIN as ChainId, DEPLOYMENT]]),
      CAPS,
      alerts as unknown as AlertPort,
      { now: () => serverSeconds * 1000 },
    );
  }
});
