import { AssetId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import {
  INTERNAL_ACCOUNTS,
  JournalEntry,
  LedgerAccountId,
  LedgerEntryType,
} from '@modules/ledger/ports/ledger.types';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * Fixed test fixtures for the pure-domain ledger tests.
 *
 * These are not the harness's `USDC_ASSET` (test/integration owns that) —
 * this file exists purely so `foldEntries`/`foldJournal` have something to
 * chew on without a database.
 */
export const ORG = 'org-11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = 'org-22222222-2222-4222-8222-222222222222';

export const USDC =
  `${CHAIN_IDS.BASE_MAINNET}/erc20:0xUSDC00000000000000000000000000000000` as AssetId;
export const USDC_DECIMALS = 6;

export const WETH =
  `${CHAIN_IDS.BASE_MAINNET}/erc20:0xWETH00000000000000000000000000000000` as AssetId;
export const WETH_DECIMALS = 18;

/** A deterministic CAIP-10 account id for a short label — mirrors the integration harness. */
export function testAccount(label: string): LedgerAccountId {
  return toAccountId(CHAIN_IDS.BASE_MAINNET, `0x${label}`);
}

export const PLATFORM_FEES: LedgerAccountId = INTERNAL_ACCOUNTS.PLATFORM_FEES;

let seqCounter = 0;

export interface MakeEntryOptions {
  readonly organizationId?: string;
  readonly asset?: AssetId;
  readonly decimals?: number;
  readonly intentId?: string | null;
  readonly holdId?: string | null;
  readonly batchId?: string | null;
  readonly chainTxRef?: string | null;
  readonly createdAt?: Date;
}

/** Builds one `JournalEntry`, as if freshly read back from the journal. */
export function makeEntry(
  accountId: LedgerAccountId,
  entryType: LedgerEntryType,
  amount: bigint,
  options: MakeEntryOptions = {},
): JournalEntry {
  seqCounter += 1;
  const asset = options.asset ?? USDC;
  const decimals = options.decimals ?? USDC_DECIMALS;
  return {
    id: `entry-${seqCounter}`,
    seq: String(seqCounter),
    organizationId: options.organizationId ?? ORG,
    accountId,
    entryType,
    money: MoneyUtil.of(amount, asset, decimals),
    intentId: options.intentId ?? null,
    holdId: options.holdId ?? null,
    batchId: options.batchId ?? null,
    chainTxRef: options.chainTxRef ?? null,
    createdAt: options.createdAt ?? new Date(),
  };
}

/**
 * Fisher-Yates, using a caller-supplied source so it is reproducible under
 * fast-check.
 *
 * The index is clamped because the source is `[0, 1]` **inclusive**, not
 * `[0, 1)`: `fc.double({ min: 0, max: 1 })` deliberately biases towards its
 * boundaries, so it returns exactly `1` regularly rather than never. Unclamped,
 * `Math.floor(1 * (i + 1))` indexes one past the end on the first iteration,
 * which writes an `undefined` into the array and lengthens it — silently
 * corrupting the journal the property is about to fold, and failing as if the
 * fold were wrong.
 */
export function shuffleWith<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(random() * (i + 1)));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
