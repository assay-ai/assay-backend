import { join } from 'path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { EvmGasGrantEntity } from '@database/postgres/entities/evm-gas-grant.entity';
import { EvmGasGrantRepository } from '@database/postgres/repositories/evm-gas-grant.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { EvmDeployment } from '@modules/chains/evm/evm.constants';
import {
  EvmGasGrantService,
  GasGrantRefusal,
  GasGrantOutcome,
} from '@modules/chains/evm/evm-gas-grant.service';
import { EvmRelayResult, EvmRelayerPort } from '@modules/chains/evm/ports/evm-relayer.port';
import { AlertPort } from '@shared/alerting';
import { MoneyUtil } from '@shared/utils/money.util';

import { ensureTestDatabase, testConnectionOptions } from '../helpers/test-database';

const CHAIN = CHAIN_IDS.ROBINHOOD_TESTNET;
const ASSET = ASSET_IDS.USDG_ROBINHOOD_TESTNET as AssetId;
const ORGANIZATION = '11111111-1111-4111-8111-111111111111';
const OTHER_ORGANIZATION = '22222222-2222-4222-8222-222222222222';

const DEPLOYMENT: EvmDeployment = {
  chainId: CHAIN,
  config: '0x1111111111111111111111111111111111111111',
  stake: '0x2222222222222222222222222222222222222222',
  escrow: '0x3333333333333333333333333333333333333333',
  asset: '0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac',
  // Both are fields of `EvmDeployment`; neither is read on this path.
  escrowImplementation: '0x8888888888888888888888888888888888888888',
  admin: '0x9999999999999999999999999999999999999999',
  owner: '0x7777777777777777777777777777777777777777',
};

const NOW_SECONDS = 1_800_000_000;
const ESTIMATED_GAS = 60_000n;
const FEE_PER_GAS = 100_000_000n;
const EXPECTED_WEI = (ESTIMATED_GAS * FEE_PER_GAS * 12n) / 10n;

/**
 * The once-ever bound, against a REAL unique index.
 *
 * The unit suite runs `EvmGasGrantService` over an in-memory Map where a unique
 * index does not exist — which is exactly how three maker/checker defects
 * survived 2 850 green tests. So the bound
 * gets its own suite here, on a database built from the migrations themselves.
 *
 * ## Two separate service instances, deliberately
 *
 * `EvmGasGrantService` serialises concurrent grants to one account through an
 * in-process promise queue, so two calls on ONE instance never race — and a
 * concurrency test written that way would stay green with the unique index
 * dropped, proving the queue and nothing else. The cases below therefore drive
 * **two instances**, which is what two API processes are, and the only thing
 * standing between them is the index.
 */
describe('the gas grant is once per address, against a real unique index', () => {
  const DATABASE = 'x402_gas_grant_test';

  let dataSource: DataSource;
  let grants: EvmGasGrantRepository;
  let sends: number;

  beforeAll(async () => {
    await dropDatabase(DATABASE);
    await ensureTestDatabase(DATABASE);

    dataSource = new DataSource({
      type: 'postgres',
      ...testConnectionOptions(),
      database: DATABASE,
      entities: [EvmGasGrantEntity],
      migrations: [join(__dirname, '../../../src/database/postgres/migrations/*.ts')],
      synchronize: false,
      migrationsRun: false,
    });

    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });

    grants = new EvmGasGrantRepository(dataSource);
  }, 300_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('TRUNCATE TABLE "evm_gas_grants"');
    await dataSource.query('TRUNCATE TABLE "evm_gas_grant_reservations"');
    sends = 0;
  });

  // ── The bound ────────────────────────────────────────────────────────────

  it('two concurrent grants from two processes send ONCE and record ONE row', async () => {
    const buyer = account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');

    /*
      A BARRIER held INSIDE `reserveGrant` until both services are in it — see
      {@link RacingGrants}.

      Without one the two await-chains interleave by whatever the round trips
      happen to cost, the second reads the first's row, and the `hasGranted`
      pre-check answers. Measured: this suite passed with the unique index
      DOWNGRADED to a plain index, because the two services never actually
      raced.

      It used to sit in `sendValue`, and with the reservation in place that is
      now unreachable for the loser — it never sends at all. Moving it to
      `balanceWei` instead was measured to be WRONG in the other direction: the
      winner ran to completion and released before the loser claimed, so both
      sent and the suite reported the defect it was meant to prove fixed. The
      point at which the two paths diverge has moved from after the money left
      to before it, and the latch has to move with it.
    */
    const barrier = arrive(2);

    const [a, b] = await Promise.allSettled([
      buildService(barrier).grantWithdrawGas(ORGANIZATION, buyer),
      buildService(barrier).grantWithdrawGas(ORGANIZATION, buyer),
    ]);

    // The whole fix, in one number. This was 2: both processes passed every
    // pre-check, both called `sendValue`, and the float paid twice while the
    // unique index kept the ledger honest about it.
    expect(sends).toBe(1);

    const rows = await grants.find({ where: { organizationId: ORGANIZATION } });
    expect(rows).toHaveLength(1);

    // And the loser must be a REFUSED outcome, not a thrown 500: a race the
    // database settled correctly is not an error the buyer should see.
    const outcomes = [a, b]
      .map((r) => (r.status === 'fulfilled' ? (r.value as GasGrantOutcome).kind : 'THREW'))
      .sort();
    expect(outcomes).toEqual(['GRANTED', 'REFUSED']);
    // …and the refusal names the TRANSIENT reason. `ALREADY_GRANTED` here would
    // tell a buyer whose grant is still intact that their one chance is spent.
    expect(
      [a, b]
        .map((r) => (r.status === 'fulfilled' ? (r.value as GasGrantOutcome) : null))
        .find((outcome) => outcome?.kind === 'REFUSED'),
    ).toEqual({ kind: 'REFUSED', reason: GasGrantRefusal.GRANT_IN_FLIGHT });

    // The winner gave its reservation back; nothing is left holding the address.
    expect(await reservations()).toHaveLength(0);
  });

  it('holds the reservation ACROSS the send, not merely up to it', async () => {
    /*
      The property the reservation exists for, and the one a two-caller race
      cannot see. With both processes latched inside `reserveGrant`, the loser is
      refused whatever the winner does afterwards — so releasing the reservation
      one line BEFORE `sendValue` passes every other case in this file.
      Measured: that mutation left all 13 green.

      This case is not a race at all. It drives the winner into `sendValue`,
      stops it there, and then makes a SECOND, entirely serial attempt — which
      is what an API replica handling the buyer's retry is. `hasGranted` is still
      false at that moment, because the grant row does not exist until the money
      has moved, and that gap is the whole seam.
    */
    const buyer = account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');
    const inSend = deferred();
    const finishSend = deferred();

    const winner = buildService(undefined, async () => {
      inSend.resolve();
      await finishSend.promise;
    }).grantWithdrawGas(ORGANIZATION, buyer);

    await inSend.promise;

    expect(await buildService().grantWithdrawGas(ORGANIZATION, buyer)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.GRANT_IN_FLIGHT,
    });

    finishSend.resolve();
    expect((await winner).kind).toBe('GRANTED');
    expect(sends).toBe(1);
    expect(await reservations()).toHaveLength(0);
  });

  it('a live reservation refuses a second process outright', async () => {
    // The serial statement of the case above, with the reservation planted by
    // hand: one attempt is in flight, and a second must not send.
    const buyer = account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');
    await grants.reserveGrant({
      organizationId: OTHER_ORGANIZATION,
      chainId: CHAIN,
      accountId: buyer,
      leaseMs: 60_000,
    });

    expect(await buildService().grantWithdrawGas(ORGANIZATION, buyer)).toEqual({
      kind: 'REFUSED',
      reason: GasGrantRefusal.GRANT_IN_FLIGHT,
    });
    expect(sends).toBe(0);
  });

  it('takes over a reservation older than its lease, and only then', async () => {
    // The lease is what stops a holder that crashed between claiming and
    // recording locking the buyer out of the grant forever. `leaseMs: 0` is the
    // same statement as "the row is older than the lease", written without
    // sleeping.
    const buyer = account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4');

    expect(
      await grants.reserveGrant({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: buyer,
        leaseMs: 60_000,
      }),
    ).toEqual({ claimed: true, takenOver: false });

    // Inside the lease: refused, and the holder keeps it.
    expect(
      await grants.reserveGrant({
        organizationId: OTHER_ORGANIZATION,
        chainId: CHAIN,
        accountId: buyer,
        leaseMs: 60_000,
      }),
    ).toEqual({ claimed: false, takenOver: false });

    // Past it: claimed, and REPORTED as a takeover — an attempt that never
    // finished is always worth an operator's attention.
    expect(
      await grants.reserveGrant({
        organizationId: OTHER_ORGANIZATION,
        chainId: CHAIN,
        accountId: buyer,
        leaseMs: 0,
      }),
    ).toEqual({ claimed: true, takenOver: true });

    // One row throughout: a takeover REPLACES the reservation, it does not add
    // a second one that a third process could claim in parallel.
    expect(await reservations()).toHaveLength(1);
  });

  it('reserves two different addresses independently', async () => {
    // The control. A reservation table keyed on a constant, or a claim that
    // refuses everything after the first, passes every case above.
    expect(
      await grants.reserveGrant({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
        leaseMs: 60_000,
      }),
    ).toEqual({ claimed: true, takenOver: false });
    expect(
      await grants.reserveGrant({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
        leaseMs: 60_000,
      }),
    ).toEqual({ claimed: true, takenOver: false });

    expect(await reservations()).toHaveLength(2);
  });

  it('refuses a reservation whose chain prefix does not match chain_id', async () => {
    // The same CHECK the grants table carries, and for the same reason: two
    // spellings of one address under two chain ids would be two rows, and the
    // unique index would stop meaning "one attempt per address".
    await expect(
      grants.reserveGrant({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: `${CHAIN_IDS.SOLANA_DEVNET}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`,
        leaseMs: 60_000,
      }),
    ).rejects.toThrow(/chk_evm_gas_grant_reservations_account_on_chain/);
  });

  it('one process does not race itself — the queue holds the second call', async () => {
    // The in-process half, and the reason the case above needs two instances.
    // One service serialises per account, so the second call sees the first's
    // row and never sends.
    const buyer = account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
    const service = buildService();

    const [a, b] = await Promise.all([
      service.grantWithdrawGas(ORGANIZATION, buyer),
      service.grantWithdrawGas(ORGANIZATION, buyer),
    ]);

    expect(sends).toBe(1);
    expect([a.kind, b.kind].sort()).toEqual(['GRANTED', 'REFUSED']);
  });

  it('a SECOND organization cannot get a second grant to the same address', async () => {
    // The bound is on the ADDRESS. An organization-scoped read cannot see
    // another tenant's row, so an attacker who can create organizations would
    // otherwise get one grant per organization — which is why `hasGranted` is
    // cross-tenant and the unique index carries no `organization_id`.
    const buyer = account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');

    const first = await buildService().grantWithdrawGas(ORGANIZATION, buyer);
    const second = await buildService().grantWithdrawGas(OTHER_ORGANIZATION, buyer);

    expect(first.kind).toBe('GRANTED');
    expect(second).toEqual({ kind: 'REFUSED', reason: GasGrantRefusal.ALREADY_GRANTED });
    expect(sends).toBe(1);
  });

  it('grants to a DIFFERENT address after one has been funded', async () => {
    // The control. An index on a constant, or a service that refuses everything
    // after its first grant, passes both cases above.
    const first = await buildService().grantWithdrawGas(
      ORGANIZATION,
      account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
    );
    const second = await buildService().grantWithdrawGas(
      ORGANIZATION,
      account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
    );

    expect([first.kind, second.kind]).toEqual(['GRANTED', 'GRANTED']);
    expect(await grants.find({ where: { organizationId: ORGANIZATION } })).toHaveLength(2);
  });

  // ── The two CHECKs ───────────────────────────────────────────────────────

  it('refuses an account_id whose chain prefix does not match chain_id', async () => {
    await expect(
      grants.insert({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: `${CHAIN_IDS.SOLANA_DEVNET}:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU`,
        wei: '1',
        transactionHash: '0x' + 'a'.repeat(64),
      }),
    ).rejects.toThrow(/chk_evm_gas_grants_account_on_chain/);
  });

  it('refuses a grant of zero wei', async () => {
    // A row saying "we sent nothing" would consume the once-ever budget for an
    // address that never got any gas.
    await expect(
      grants.insert({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
        wei: '0',
        transactionHash: '0x' + 'b'.repeat(64),
      }),
    ).rejects.toThrow(/chk_evm_gas_grants_wei_positive/);
  });

  it('accepts a matching account_id — the control for the CHECK above', async () => {
    await expect(
      grants.insert({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
        wei: '1',
        transactionHash: '0x' + 'c'.repeat(64),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses two rows carrying the same transaction hash', async () => {
    const hash = '0x' + 'd'.repeat(64);
    await grants.insert({
      organizationId: ORGANIZATION,
      chainId: CHAIN,
      accountId: account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
      wei: '1',
      transactionHash: hash,
    });

    await expect(
      grants.insert({
        organizationId: ORGANIZATION,
        chainId: CHAIN,
        accountId: account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
        wei: '1',
        transactionHash: hash,
      }),
    ).rejects.toThrow(/uniq_evm_gas_grants_transaction/);
  });

  // ── The daily cap reads the real SUM ─────────────────────────────────────

  it('sums the last 24 hours across every tenant, and excludes older rows', async () => {
    await grants.insert({
      organizationId: ORGANIZATION,
      chainId: CHAIN,
      accountId: account('0x5B38Da6a701c568545dCfcB03FcB875f56beddC4'),
      wei: '100',
      transactionHash: '0x' + 'e'.repeat(64),
    });
    await grants.insert({
      organizationId: OTHER_ORGANIZATION,
      chainId: CHAIN,
      accountId: account('0x742d35Cc6634C0532925a3b844Bc454e4438f44e'),
      wei: '200',
      transactionHash: '0x' + 'f'.repeat(64),
    });

    expect(await grants.grantedWeiSince(new Date(Date.now() - 60_000))).toBe(300n);
    expect(await grants.grantedWeiSince(new Date(Date.now() + 60_000))).toBe(0n);
  });

  // ── Helpers ──────────────────────────────────────────────────────────────

  function account(address: string): AccountId {
    return `${CHAIN}:${address}` as AccountId;
  }

  /** Raw, because the reservation table deliberately has no entity. */
  async function reservations(): Promise<{ account_id: string }[]> {
    return (await dataSource.query(
      'SELECT "account_id", "reserved_at" FROM "evm_gas_grant_reservations"',
    )) as { account_id: string }[];
  }

  /**
   * One service, with its own queue — so two of these race the way two
   * processes do.
   */
  /**
   * A latch that resolves once `count` callers have reached it.
   *
   * The only way to make two independent services genuinely race a database is
   * to hold them both at the same point until both are there.
   */
  function arrive(count: number): () => Promise<void> {
    let waiting = 0;
    let release: () => void;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });

    return async () => {
      waiting += 1;
      if (waiting >= count) release();
      await open;
    };
  }

  /**
   * The repository, with **both processes held inside `reserveGrant`**.
   *
   * This is the only placement that makes the two statements overlap. A barrier
   * anywhere earlier — `sendValue`, `balanceWei` — releases both callers and
   * then lets whichever resumes first run to completion, including its own
   * RELEASE, before the other's claim reaches Postgres. Measured on this suite:
   * with the latch on `balanceWei` the winner finished and released, the loser
   * claimed a free table and sent, and `sends` was 2 — a green reservation
   * refusing nothing, which is the same shape as the defect this suite was
   * written to catch (it once passed with the unique index downgraded to a
   * plain one).
   *
   * Held here, both claims are issued before either returns and the database
   * decides. Everything else about the two services is untouched, so what is
   * being tested is the constraint and not the latch.
   */
  class RacingGrants {
    constructor(
      private readonly inner: EvmGasGrantRepository,
      private readonly barrier: () => Promise<void>,
    ) {}

    hasGranted(accountId: string): Promise<boolean> {
      return this.inner.hasGranted(accountId);
    }

    grantedWeiSince(since: Date): Promise<bigint> {
      return this.inner.grantedWeiSince(since);
    }

    insert(row: Parameters<EvmGasGrantRepository['insert']>[0]): Promise<unknown> {
      return this.inner.insert(row);
    }

    releaseGrantReservation(accountId: string): Promise<void> {
      return this.inner.releaseGrantReservation(accountId);
    }

    async reserveGrant(
      reservation: Parameters<EvmGasGrantRepository['reserveGrant']>[0],
    ): Promise<{ claimed: boolean; takenOver: boolean }> {
      await this.barrier();
      return this.inner.reserveGrant(reservation);
    }
  }

  /** A promise plus its resolver — one latch, no polling and no timers. */
  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  function buildService(
    barrier?: () => Promise<void>,
    onSend?: () => Promise<void>,
  ): EvmGasGrantService {
    const relayer: EvmRelayerPort = {
      name: 'fake',
      address: async () => account('0x9999999999999999999999999999999999999999'),
      balanceWei: async () => EXPECTED_WEI * 1_000n,
      sendCall: async () => {
        throw new Error('the gas grant must never reach sendCall');
      },
      sendValue: async (): Promise<EvmRelayResult> => {
        sends += 1;
        if (onSend) await onSend();
        // A distinct hash per send, so `uniq_evm_gas_grants_transaction` cannot
        // stand in for the account index and make this suite pass for the wrong
        // reason.
        return {
          hash: `0x${sends.toString(16).padStart(64, '0')}`,
          status: 'SUCCESS',
          revertReason: null,
          gasUsed: 21_000n,
          blockNumber: 1n,
        };
      },
    };

    return new EvmGasGrantService(
      (barrier ? new RacingGrants(grants, barrier) : grants) as never,
      {
        read: async () => ({
          balance: MoneyUtil.of('1000000', ASSET, 6),
          seqHigh: 0n,
          withdrawRequested: 5_000_000n,
          withdrawAvailableAt: NOW_SECONDS - 60,
          maxVoucherAmount: 0n,
          maxPerWindow: 0n,
          spentInWindow: 0n,
          windowStartedAt: 0,
          observedAt: new Date(NOW_SECONDS * 1000),
        }),
      } as never,
      relayer,
      new Map([
        [
          CHAIN as ChainId,
          {
            estimateGas: async () => ESTIMATED_GAS,
            estimateFeesPerGas: async () => ({
              maxFeePerGas: FEE_PER_GAS,
              maxPriorityFeePerGas: FEE_PER_GAS / 10n,
            }),
            getBalance: async () => 0n,
            // The chain's clock, and the one control 2 judges maturity on. Held
            // at the fixture's `NOW_SECONDS`, 60 s past `withdrawAvailableAt`.
            getBlock: async () => ({ timestamp: BigInt(NOW_SECONDS) }),
            getCode: async () => undefined,
          },
        ],
      ]),
      new Map([[CHAIN as ChainId, DEPLOYMENT]]),
      {
        perGrantMaxWei: EXPECTED_WEI * 4n,
        dailyMaxWei: EXPECTED_WEI * 100n,
        relayerFloatLowWaterWei: 1n,
      },
      { emit: async () => undefined } as unknown as AlertPort,
      { now: () => NOW_SECONDS * 1000 },
    );
  }

  async function dropDatabase(database: string): Promise<void> {
    const connection = testConnectionOptions();
    const admin = new Client({
      host: connection.host,
      port: connection.port,
      user: connection.username,
      password: connection.password,
      database: 'postgres',
    });
    await admin.connect();
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${database.replace(/"/g, '""')}" WITH (FORCE)`);
    } finally {
      await admin.end();
    }
  }
});
