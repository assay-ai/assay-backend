import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { AccountBalance } from '@modules/ledger/ports/ledger.types';
import { BalancesService } from '@modules/ledger/services/balances.service';
import {
  EscrowSpendGateService,
  Spendable,
} from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import { WithheldReconciliation } from '@modules/ledger/domain/withheld';
import { MoneyUtil } from '@shared/utils/money.util';
import { ApiErrorCode } from '@shared/api';
import { BaseError } from '@shared/errors/base.error';

import { ORG, USDC, USDC_DECIMALS } from './helpers/entries';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

function money(amount: string) {
  return MoneyUtil.of(amount, USDC, USDC_DECIMALS);
}

function accountBalance(overrides: Partial<AccountBalance> = {}): AccountBalance {
  return {
    organizationId: ORG,
    accountId: 'solana:mainnet:acct' as AccountBalance['accountId'],
    asset: USDC,
    decimals: USDC_DECIMALS,
    available: money('1000000'),
    held: money('20000'),
    pending: money('0'),
    total: money('1020000'),
    ...overrides,
  };
}

function emptyReconciliation(): WithheldReconciliation {
  const zero = MoneyUtil.zero(USDC, USDC_DECIMALS);
  return {
    withheld: { asset: USDC, calls: 0, amount: zero, buckets: [] },
    holdReleaseTotal: zero,
    orphanedReleases: zero,
    orphanedHoldIds: [],
    ok: true,
    difference: '0',
  };
}

function build(options: {
  balances?: AccountBalance[];
  reconcile?: jest.Mock;
  pendingRows?: Array<{ assetId: string; decimals: number; amount: string }>;
  spendable?: jest.Mock;
}) {
  const ledger = {
    listBalances: jest.fn().mockResolvedValue(options.balances ?? [accountBalance()]),
  } as unknown as LedgerService;

  const withheld = {
    reconcile: options.reconcile ?? jest.fn().mockResolvedValue(emptyReconciliation()),
  } as unknown as LedgerWithheldService;

  const fake = fakeQueryBuilder(options.pendingRows ?? []);
  const deposits = {
    createQueryBuilder: jest.fn().mockReturnValue(fake.qb),
  } as unknown as DepositIntentRepository;

  // `GET /balances` always asks the gate for the chain figure,
  // regardless of `ESCROW_SPEND_GATE_ENABLED` — see `chainFiguresFor`'s own
  // comment. Defaults to a spendable reading of `1000000`, matching
  // `accountBalance()`'s default `available`.
  const escrowGate = {
    spendable: options.spendable ?? jest.fn().mockResolvedValue(defaultSpendable()),
  } as unknown as EscrowSpendGateService;

  return {
    service: new BalancesService(ledger, withheld, deposits, escrowGate),
    ledger,
    withheld,
    fake,
    escrowGate,
  };
}

function defaultSpendable(): Spendable {
  return {
    chain: money('1000000'),
    openHolds: money('0'),
    spendable: money('1000000'),
    withdrawRequested: 0n,
  };
}

describe('BalancesService.getBalances', () => {
  it('reports chainBalance and spendable from the gate, and withdrawable equal to the chain figure', async () => {
    const spendable = jest.fn().mockResolvedValue({
      withdrawRequested: 0n,
      chain: money('900000'),
      openHolds: money('100000'),
      spendable: money('800000'),
    });
    const { service } = build({
      balances: [accountBalance({ available: money('1000000') })],
      spendable,
    });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].chainBalance).toEqual(money('900000'));
    expect(result.balances[0].spendable).toEqual(money('800000'));
    // No longer `available` — the chain figure is what `withdraw()`
    // actually respects.
    expect(result.balances[0].withdrawable).toEqual(money('900000'));
  });

  it('reports null, never zero, when the chain could not be read', async () => {
    const spendable = jest.fn().mockRejectedValue(new Error('escrow balance unavailable'));
    const { service } = build({ balances: [accountBalance()], spendable });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].chainBalance).toBeNull();
    expect(result.balances[0].spendable).toBeNull();
    expect(result.balances[0].withdrawable).toBeNull();
  });

  it('reports null when the account has no escrow yet', async () => {
    const spendable = jest.fn().mockResolvedValue(null);
    const { service } = build({ balances: [accountBalance()], spendable });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].chainBalance).toBeNull();
    expect(result.balances[0].withdrawable).toBeNull();
  });

  it('zero-fills pendingDeposits when the asset has no in-flight deposit intents', async () => {
    const { service } = build({ balances: [accountBalance()], pendingRows: [] });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].pendingDeposits).toEqual({
      amount: '0',
      asset: USDC,
      decimals: USDC_DECIMALS,
    });
  });

  it('sums CREATED/SETTLING deposit intents into pendingDeposits, per asset', async () => {
    const { service } = build({
      balances: [accountBalance()],
      pendingRows: [{ assetId: USDC, decimals: USDC_DECIMALS, amount: '5000000' }],
    });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].pendingDeposits).toEqual({
      amount: '5000000',
      asset: USDC,
      decimals: USDC_DECIMALS,
    });
  });

  it('stops counting a CREATED deposit intent once its deadline has passed', async () => {
    // A `POST /deposits` that the buyer never funded — or that answered an
    // error after the row was written — leaves a `CREATED` row behind until
    // the expiry sweep reaches it. Counting it as `pendingDeposits` shows the
    // buyer money nobody ever sent, and the sweep only runs in the scheduler
    // process, so status alone is not a bound.
    const { service, fake } = build({ balances: [accountBalance()], pendingRows: [] });

    await service.getBalances(ORG);

    const clause = fake.wheres.find((where) => where.sql.includes('intent.status'));
    expect(clause).toBeDefined();
    expect(clause!.sql).toBe(
      '(intent.status = :settling OR (intent.status = :created AND intent.expiresAt > :now))',
    );
    expect(clause!.params.now).toBeInstanceOf(Date);
  });

  it('counts a SETTLING deposit intent whatever its deadline says', async () => {
    // Settlement is already in flight and the transaction may well have
    // landed; the deadline stops a *new* payload being accepted, it does not
    // mean the money is gone. Only the CREATED branch is bounded by it.
    const { service, fake } = build({ balances: [accountBalance()], pendingRows: [] });

    await service.getBalances(ORG);

    const clause = fake.wheres.find((where) => where.sql.includes('intent.status'))!;
    const settlingTerm = clause.sql.slice(0, clause.sql.indexOf(' OR '));
    expect(settlingTerm).toBe('(intent.status = :settling');
  });

  it('reconciles withheld once per distinct asset across balances', async () => {
    const reconcile = jest.fn().mockResolvedValue(emptyReconciliation());
    const { service } = build({
      balances: [accountBalance(), accountBalance({ accountId: 'solana:mainnet:other' as any })],
      reconcile,
    });

    await service.getBalances(ORG);

    expect(reconcile).toHaveBeenCalledTimes(1);
    // The scale is passed, and it is the LEDGER's — read off the balance row
    // rather than out of the asset registry, so an asset the registry does not
    // know can still be reconciled.
    expect(reconcile).toHaveBeenCalledWith(ORG, USDC, USDC_DECIMALS);
  });

  // `platform:fees` is booked under the BUYER's organizationId — see
  // `LedgerHoldService.commitHoldAndCredit`, which prepares the `PLATFORM_FEE`
  // entry with the paying org's id while the provider credit correctly uses
  // `credit.providerOrganizationId`. So every organization that has ever paid
  // for a call carries a `platform:fees` row of its own, and it is not their
  // money: `ledger-book.ts` keeps `platformFees` as a book distinct from
  // `agentLiabilities`.
  //
  // Returning it to the customer is wrong twice over. `AccountBalanceDto`
  // carries no account id, so two rows for one asset are indistinguishable on
  // the wire — a client cannot tell which is its own, and one that sums them
  // reports money the org cannot spend.
  it('omits internal platform accounts — they are the platform’s book, not the customer’s', async () => {
    const { service } = build({
      balances: [
        accountBalance({
          available: money('25043456'),
          held: money('0'),
          total: money('25043456'),
        }),
        accountBalance({
          accountId: 'platform:fees' as AccountBalance['accountId'],
          available: money('16000'),
          held: money('0'),
          total: money('16000'),
        }),
      ],
    });

    const result = await service.getBalances(ORG);

    expect(result.balances).toHaveLength(1);
    expect(result.balances[0].available.amount).toBe('25043456');
  });
});

describe('BalancesService.getWithheld', () => {
  it('passes the from/to window through to LedgerWithheldService.reconcile', async () => {
    const reconcile = jest.fn().mockResolvedValue(emptyReconciliation());
    const { service } = build({ balances: [accountBalance()], reconcile });
    const from = new Date('2026-08-01T00:00:00.000Z');
    const to = new Date('2026-09-01T00:00:00.000Z');

    await service.getWithheld(ORG, { from, to });

    expect(reconcile).toHaveBeenCalledWith(ORG, USDC, USDC_DECIMALS, { from, to });
  });

  it('rejects a reversed time window with API_INVALID_TIME_RANGE, before touching the ledger', async () => {
    const { service, ledger } = build({});
    const from = new Date('2026-09-01T00:00:00.000Z');
    const to = new Date('2026-08-01T00:00:00.000Z');

    let caught: unknown;
    try {
      await service.getWithheld(ORG, { from, to });
    } catch (error) {
      caught = error;
    }

    expect((caught as BaseError).errorCode).toBe(ApiErrorCode.API_INVALID_TIME_RANGE);
    expect(ledger.listBalances).not.toHaveBeenCalled();
  });

  it('returns one reconciliation per asset with a balance', async () => {
    const { service } = build({ balances: [accountBalance()] });

    const result = await service.getWithheld(ORG);

    expect(result).toHaveLength(1);
    expect(result[0].withheld.asset).toBe(USDC);
  });

  // Same filter as `getBalances`, and it has to be: this method picks the
  // assets to reconcile from the balance rows, so an asset the organization
  // touches ONLY through the platform's fee book would otherwise be reported
  // as an asset the customer holds withheld money in.
  it('does not reconcile an asset the organization holds only through an internal account', async () => {
    const reconcile = jest.fn().mockResolvedValue(emptyReconciliation());
    const { service } = build({
      balances: [accountBalance({ accountId: 'platform:fees' as AccountBalance['accountId'] })],
      reconcile,
    });

    const result = await service.getWithheld(ORG);

    expect(reconcile).not.toHaveBeenCalled();
    expect(result).toHaveLength(0);
  });
});

/**
 * One row in an asset this platform has no metadata for, measured live
 * as `400 CHAIN_ASSET_UNKNOWN` for the **whole** of `GET /balances`:
 *
 * ```text
 * No asset metadata registered for
 * solana:EtWT…/token:61Ci2BAh6PUMtr3zAG3r2EFBr5arDkGgSjGv5Nx9eVbv
 * ```
 *
 * The response is assembled per asset, so one asset that refused to be
 * described refused the response — and a buyer holding a single historical row
 * in a retired token saw **no balances at all**, including the ones in the
 * asset they use every day. Balances are a list, never a sum and never
 * just the first row; an unreadable row must appear as a row that is
 * unreadable, never be dropped, and never take its neighbours with it.
 *
 * These tests wire the **real** `LedgerWithheldService`, because that is where
 * the throw was. A mocked `reconcile` would pass against the unfixed code and
 * prove nothing.
 */
describe('GET /balances with a row in an asset the registry does not know', () => {
  /** Registered — `ASSET_IDS`, not a literal, so this cannot silently stop being registered. */
  const KNOWN = ASSET_IDS.USDC_SOLANA_DEVNET;
  /** The measured retired token. Well-formed CAIP-19, and in no registry row. */
  const RETIRED =
    `${CHAIN_IDS.SOLANA_DEVNET}/token:61Ci2BAh6PUMtr3zAG3r2EFBr5arDkGgSjGv5Nx9eVbv` as AssetId;

  const ACCOUNT = toAccountId(
    CHAIN_IDS.SOLANA_DEVNET,
    'BuyerAccount111111111111111111111111111111',
  );

  function row(asset: AssetId, amount: string): AccountBalance {
    return accountBalance({
      accountId: ACCOUNT as AccountBalance['accountId'],
      asset,
      decimals: 6,
      available: MoneyUtil.of(amount, asset, 6),
      held: MoneyUtil.zero(asset, 6),
      pending: MoneyUtil.zero(asset, 6),
      total: MoneyUtil.of(amount, asset, 6),
    });
  }

  /** The real folding service over empty repositories — the zero-fill path that threw. */
  function realWithheld(): LedgerWithheldService {
    const entries = {
      sumEntryTypeByAsset: jest.fn().mockResolvedValue([]),
      findOrphanedHoldReleases: jest.fn().mockResolvedValue([]),
    };
    const intents = { sumWithheldByAssetAndStatus: jest.fn().mockResolvedValue([]) };
    return new LedgerWithheldService(entries as never, intents as never);
  }

  function buildWithRealWithheld(balances: AccountBalance[]) {
    const { service, ledger } = build({ balances, reconcile: jest.fn() });
    // Swap the mock out for the real thing: `build` cannot construct it, and
    // this is the one seam these tests exist to exercise.
    (service as unknown as { withheld: LedgerWithheldService }).withheld = realWithheld();
    return { service, ledger };
  }

  it('answers, instead of failing the whole response', async () => {
    const { service } = buildWithRealWithheld([row(RETIRED, '250000')]);

    await expect(service.getBalances(ORG)).resolves.toBeDefined();
  });

  it('lists the unknown row AND its neighbours — neither dropped, neither emptied', async () => {
    // The two degenerate implementations this kills: returning `[]` when any
    // row is unknown, and quietly filtering the unknown row out. Both would
    // answer 200 and both would show a buyer less money than they have.
    const { service } = buildWithRealWithheld([row(KNOWN, '1000000'), row(RETIRED, '250000')]);

    const result = await service.getBalances(ORG);

    expect(result.balances).toHaveLength(2);
    expect(result.balances.map((balance) => balance.asset)).toEqual([KNOWN, RETIRED]);
  });

  it('reports the unknown row’s money in full, at the ledger’s own scale', async () => {
    const { service } = buildWithRealWithheld([row(RETIRED, '250000')]);

    const result = await service.getBalances(ORG);

    expect(result.balances[0].available).toEqual({
      amount: '250000',
      asset: RETIRED,
      decimals: 6,
    });
    expect(result.balances[0].total.amount).toBe('250000');
  });

  it('marks the row assetKnown: false and its neighbour assetKnown: TRUE', async () => {
    // A handler that stamped `assetKnown: false` on everything would pass the
    // test above. This is the one that kills it.
    const { service } = buildWithRealWithheld([row(KNOWN, '1000000'), row(RETIRED, '250000')]);

    const result = await service.getBalances(ORG);

    expect(result.balances[0].assetKnown).toBe(true);
    expect(result.balances[1].assetKnown).toBe(false);
  });

  it('still reconciles withheld for the unknown asset — the figure is not dropped either', async () => {
    const { service } = buildWithRealWithheld([row(KNOWN, '1000000'), row(RETIRED, '250000')]);

    const result = await service.getBalances(ORG);

    expect(result.withheld.map((entry) => entry.withheld.asset)).toEqual([KNOWN, RETIRED]);
    // Zero-filled at the LEDGER's scale — the fallback that used to demand a
    // registry entry to know what scale a zero is quoted in.
    expect(result.withheld[1].withheld.amount).toEqual({
      amount: '0',
      asset: RETIRED,
      decimals: 6,
    });
    expect(result.withheld[1].ok).toBe(true);
  });
});

/**
 * The three states a row's chain figures can be in, which the wire
 * previously collapsed into one `null`.
 */
describe('BalancesService reports whether each row’s chain was read', () => {
  it('true, with figures, when the chain answered', async () => {
    const { service } = build({ balances: [accountBalance()] });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].chainReadable).toBe(true);
    expect(result.balances[0].chainBalance?.amount).toBe('1000000');
  });

  it('true, with nulls, when the chain says this account has no escrow yet', async () => {
    const spendable = jest.fn().mockResolvedValue(null);
    const { service } = build({ balances: [accountBalance()], spendable });

    const result = await service.getBalances(ORG);

    // The chain answered. "You have not deposited" is a fact about the escrow.
    expect(result.balances[0].chainReadable).toBe(true);
    expect(result.balances[0].chainBalance).toBeNull();
  });

  it('false when the read failed — the only case where those nulls are unknowns', async () => {
    const spendable = jest.fn().mockRejectedValue(new Error('escrow balance unavailable'));
    const { service } = build({ balances: [accountBalance()], spendable });

    const result = await service.getBalances(ORG);

    expect(result.balances[0].chainReadable).toBe(false);
    expect(result.balances[0].chainBalance).toBeNull();
  });

  it('marks only the row that failed, never the list', async () => {
    // One unreadable escrow must not take down a page that lists five
    // others, and the flag has to be per row for that to be visible.
    const other = accountBalance({
      accountId: 'solana:mainnet:other' as AccountBalance['accountId'],
    });
    const spendable = jest.fn(async (_org: string, account: string) => {
      if (account === 'solana:mainnet:other') throw new Error('rpc down');
      return defaultSpendable();
    });
    const { service } = build({
      balances: [accountBalance(), other],
      spendable: spendable as never,
    });

    const result = await service.getBalances(ORG);

    expect(result.balances).toHaveLength(2);
    expect(result.balances[0].chainReadable).toBe(true);
    expect(result.balances[1].chainReadable).toBe(false);
  });
});
