import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { DepositIntentRepository } from '@database/postgres/repositories/deposit-intent.repository';
import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { GetBalancesResponseDto } from '@modules/ledger/dto/get-balances.dto';
import { WithheldReconciliation } from '@modules/ledger/domain/withheld';
import { AccountBalance, LedgerAccountId } from '@modules/ledger/ports/ledger.types';
import { BalancesService } from '@modules/ledger/services/balances.service';
import { EscrowSpendGateService } from '@modules/ledger/services/escrow-spend-gate.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { LedgerWithheldService } from '@modules/ledger/services/ledger-withheld.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { ORG } from './helpers/entries';
import { fakeQueryBuilder } from './helpers/fake-query-builder';

const DEVNET: ChainId = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET: ChainId = CHAIN_IDS.SOLANA_MAINNET;
const DECIMALS = 6;

interface Row {
  readonly accountId: string;
  readonly asset: string;
  readonly available: string;
}

function toAccountBalance(row: Row): AccountBalance {
  const zero = MoneyUtil.zero(row.asset as AssetId, DECIMALS);
  const available = MoneyUtil.of(row.available, row.asset as AssetId, DECIMALS);

  return {
    organizationId: ORG,
    accountId: row.accountId as LedgerAccountId,
    asset: row.asset as AssetId,
    decimals: DECIMALS,
    available,
    held: zero,
    pending: zero,
    total: available,
  };
}

function emptyReconciliation(asset: string): WithheldReconciliation {
  const zero = MoneyUtil.zero(asset as AssetId, DECIMALS);
  return {
    withheld: { asset: asset as AssetId, calls: 0, amount: zero, buckets: [] },
    holdReleaseTotal: zero,
    orphanedReleases: zero,
    orphanedHoldIds: [],
    orphanedHoldCount: 0,
    settlementRemainders: zero,
    ok: true,
    difference: '0',
  };
}

/**
 * `BalancesService` over stubbed collaborators, in the style of
 * `balances.service.spec.ts`.
 *
 * `escrowGate.spendable` deliberately resolves `null` for every account: the
 * chain figures are not the subject here, and returning `null` keeps the
 * serialised response free of any number this file did not put there — which
 * the "16500000 appears nowhere" assertion depends on.
 */
async function buildBalances(rows: readonly Row[]): Promise<GetBalancesResponseDto> {
  const balances = rows.map(toAccountBalance);

  const ledger = {
    listBalances: jest.fn().mockResolvedValue(balances),
  } as unknown as LedgerService;

  const withheld = {
    reconcileAssets: jest
      .fn()
      .mockImplementation((_org: string, assets: { asset: string }[]) =>
        Promise.resolve(assets.map(({ asset }) => emptyReconciliation(asset))),
      ),
  } as unknown as LedgerWithheldService;

  const deposits = {
    createQueryBuilder: jest.fn().mockReturnValue(fakeQueryBuilder([]).qb),
  } as unknown as DepositIntentRepository;

  const escrowGate = {
    spendable: jest.fn().mockResolvedValue(null),
  } as unknown as EscrowSpendGateService;

  return new BalancesService(ledger, withheld, deposits, escrowGate).getBalances(ORG);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * A hand-rolled fold over `.amount` that never consults `.asset`.
 *
 * `MoneyUtil.sum` and `MoneyUtil.add` both REFUSE to combine two assets — they
 * throw `MONEY_ASSET_MISMATCH` — so the danger is not those. It is BigInt
 * arithmetic that bypasses `MoneyUtil` entirely, which is exactly what someone
 * reaches for when adding two rows that `MoneyUtil` would not let them add.
 *
 * Three shapes, because there are three ways to write it:
 *
 * 1. `xs.reduce(…BigInt(…))` — the fold. `[^;]` rather than `[^)]` because an
 *    arrow-function accumulator contains a `)` before it ever reaches `BigInt`,
 *    so a `[^)]`-bounded pattern misses the single most likely spelling. An
 *    earlier draft was `[^)]`-bounded and did not match its own mutation
 *    fixture; the positive-control case below is what caught that.
 * 2. `toAtomic(a.amount) + …` — two figures added outside `MoneyUtil`.
 * 3. `total += BigInt(…)` — the same fold written as a loop.
 */
const CROSS_ASSET_FOLD = /\breduce\([^;]{0,240}BigInt\(|\.amount\s*\)\s*\+|\+=\s*BigInt\(/;

/**
 * Balances are a list, never a sum.
 *
 * There is no `total` field, and there must never be one — not even labelled
 * 'USD equivalent'. A total implies the buyer can spend it on one call. With no
 * cross-chain transfer they cannot: 12.5 USDC and 4.00 USDG are $16.50 of
 * nothing. The one number a buyer would read off a total is the one number that
 * is never true.
 *
 * `AccountBalanceDto.total` is NOT that number: it is
 * `available + held + pending` for ONE (account, asset) pair, and a CAIP-19
 * asset names exactly one chain. The forbidden thing is a field that spans
 * rows, and that is what these tests are about.
 */
describe('GET /balances is per chain', () => {
  it('the response has no field outside the per-row list', () => {
    // The subject is the RESPONSE shape. A `grandTotal`, a `totalUsd` or a
    // `combined` on GetBalancesResponseDto is the defect; anything inside a row
    // is per chain by construction.
    //
    // Read the class's OWN declaration through its swagger metadata. An earlier
    // draft instantiated the DTO, assigned two fields and asserted on
    // Object.keys — which lists exactly the fields the test assigned, and so
    // would pass with any number of forbidden fields declared. A guard satisfied
    // by its own setup is not a guard.
    const declared: string[] = (
      Reflect.getMetadata('swagger/apiModelPropertiesArray', GetBalancesResponseDto.prototype) ?? []
    ).map((key: string) => key.replace(/^:/, ''));

    expect(declared.sort()).toEqual(['balances', 'withheld']);
    expect(declared.some((name) => /total|sum|combined|aggregate|unified/i.test(name))).toBe(false);
  });

  it('the metadata read above is not vacuous', () => {
    // If the swagger metadata key ever changes name, the previous test would see
    // `[]` and fail on the equality — but say so here, so the failure reads as
    // "the probe broke", not "a field appeared".
    expect(
      Reflect.getMetadata('swagger/apiModelPropertiesArray', GetBalancesResponseDto.prototype),
    ).toBeDefined();
  });

  it('each row names its chain explicitly', async () => {
    const dto = await buildBalances([
      { accountId: `${DEVNET}:AAA`, asset: `${DEVNET}/token:USDC`, available: '12500000' },
    ]);

    expect(dto.balances[0]).toMatchObject({
      chainId: DEVNET,
      accountId: `${DEVNET}:AAA`,
    });
  });

  it('two chains produce two rows and nothing that combines them', async () => {
    const dto = await buildBalances([
      { accountId: `${DEVNET}:AAA`, asset: `${DEVNET}/token:USDC`, available: '12500000' },
      { accountId: `${MAINNET}:BBB`, asset: `${MAINNET}/token:USDC`, available: '4000000' },
    ]);

    expect(dto.balances).toHaveLength(2);
    expect(dto.balances.map((b) => b.chainId)).toEqual([DEVNET, MAINNET]);
    // 12500000 + 4000000 = 16500000 must appear NOWHERE in the response.
    expect(JSON.stringify(dto)).not.toContain('16500000');
  });

  it('the chain on a row is read off THAT row, not off the first one', async () => {
    // The degenerate this kills: `chainId: chainIdOf(balances[0].accountId)`,
    // which reports one chain's identity under every chain's key and passes
    // every assertion above that only reads `balances[0]`. Two chains in the
    // reverse order, so a row-0-derived answer is wrong for row 1 and a
    // constant answer is wrong for one of them whichever constant it picks.
    const dto = await buildBalances([
      { accountId: `${MAINNET}:BBB`, asset: `${MAINNET}/token:USDC`, available: '4000000' },
      { accountId: `${DEVNET}:AAA`, asset: `${DEVNET}/token:USDC`, available: '12500000' },
    ]);

    expect(dto.balances.map((b) => b.chainId)).toEqual([MAINNET, DEVNET]);
    expect(dto.balances.map((b) => b.accountId)).toEqual([`${MAINNET}:BBB`, `${DEVNET}:AAA`]);
  });

  it('the chain is derived from the row and not copied from a chain-shaped prefix of the asset', async () => {
    // An account and an asset name the same chain in every real row, so a
    // `chainIdOf(balance.asset)` implementation is indistinguishable from the
    // right one — until a row exists where they differ. This row cannot occur
    // in production; it exists so the two derivations are separable at all,
    // and the per-chain promise ("which chain this balance is HELD on and SPENT on")
    // names the account as the subject.
    const dto = await buildBalances([
      { accountId: `${DEVNET}:AAA`, asset: `${MAINNET}/token:USDC`, available: '1' },
    ]);

    expect(dto.balances[0].chainId).toEqual(DEVNET);
  });

  it('no source file under ledger/ sums Money across differing assets', () => {
    // A source lock, not a behaviour test. The no-sum rule is about code
    // that has not been written yet, and only a source-level guard reaches it.
    const root = join(__dirname, '../../../src/modules/ledger');
    const offenders = walk(root)
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => CROSS_ASSET_FOLD.test(readFileSync(file, 'utf8')))
      // ONE exception, named so it is visible. `reconcileWithheld` subtracts
      // three figures that `LedgerWithheldService.reconcile(org, asset)`
      // obtained for a single asset — the asset is a parameter, fixed before
      // the arithmetic runs — so it cannot span two chains.
      //
      // `balance-fold.ts` and `ledger-entry-effect.ts` are the other two legal
      // folds and are deliberately NOT excluded: they route every figure
      // through `MoneyUtil`, so they do not match, and excusing a file that
      // does not match would only hide the day it starts to.
      .filter((file) => !file.endsWith('domain/withheld.ts'));

    expect(offenders).toEqual([]);
  });

  it('the source lock above matches a cross-asset fold when one exists', () => {
    // Without this, a typo in CROSS_ASSET_FOLD leaves the previous test
    // permanently and silently satisfied — a regex that matches nothing is
    // passed by every tree, including a tree full of the thing it forbids.
    // Each entry is one shape the regex names, so a failure says which of the
    // three alternations broke rather than only that something did.
    const positives = [
      'return rows.reduce((acc, r) => acc + BigInt(r.amount), 0n);',
      'const t = toAtomic(a.amount) + toAtomic(b.amount);',
      'for (const r of rows) { total += BigInt(r.amount); }',
    ];
    for (const source of positives) {
      expect([source, CROSS_ASSET_FOLD.test(source)]).toEqual([source, true]);
    }

    // And it does NOT fire on the ordinary per-row shape, nor on a count fold
    // over something that is not money — otherwise the exception list would
    // grow until the guard meant nothing.
    const negatives = [
      'return MoneyUtil.add(row.available, row.held);',
      'buckets.reduce((total, bucket) => total + bucket.calls, 0)',
    ];
    for (const source of negatives) {
      expect([source, CROSS_ASSET_FOLD.test(source)]).toEqual([source, false]);
    }
  });
});
