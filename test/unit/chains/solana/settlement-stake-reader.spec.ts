import { Address, getAddressDecoder } from '@solana/kit';
import {
  findConfigPda,
  findStakePda,
  getConfigEncoder,
  getProviderStakeEncoder,
} from '@assay/settlement-client';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, parseAssetId, toAccountId } from '@modules/chains/ports/caip.types';
import { SolanaSettlementStakeReader } from '@modules/chains/solana/settlement-stake-reader.service';

/**
 * `SolanaSettlementStakeReader` — the `ProviderStake` account, decoded.
 *
 * ## Why this suite exists now
 *
 * The reader shipped with no spec of its own. Its only coverage was two
 * incidental cases in `onchain-provider-stake.source.spec.ts` — which is a
 * suite about caching and staleness, and reaches this file only because the
 * source it tests happens to own one. Since then the reader has been extended
 * twice: once to add `exposureUpdatedAt`, and once to add `unbondingStartedAt`,
 * `unbondingCompletesAt`, a widened `Config` memo carrying
 * `unbonding_period_seconds`, a `0n → null` sentinel helper, and date
 * arithmetic. None of that had a test that was about it.
 *
 * ## The fake is at the RPC, not at the port
 *
 * Same trade `settlement-exposure-recorder.spec.ts` and
 * `onchain-provider-stake.source.spec.ts` make, and for the same reason: the
 * account bytes are produced by the generated encoder and read by the real
 * decoder, and the PDAs are derived by the real derivation. Faking
 * `OnChainStakeReaderPort` would have made every assertion below a restatement
 * of the fake — which is exactly the failure this file is written to avoid,
 * since the alternative is that a `u64` at the wrong offset is discovered by a
 * provider whose collateral it describes.
 *
 * Nothing here touches a network or a chain.
 */

const PROGRAM_ID = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S';
const STAKE_MINT = parseAssetId(ASSET_IDS.USDC_SOLANA_DEVNET).assetReference;

/** The program's own default: 14 days, as `Config.unbonding_period_seconds`. */
const FOURTEEN_DAYS_SECONDS = 1_209_600n;
/** A fixed unix second, so the derived completion date is a fixed string. */
const UNBONDING_STARTED_AT = BigInt(Date.parse('2026-08-15T00:00:00.000Z') / 1000);

/** A deterministic, valid 32-byte address. */
function addressOf(seed: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(seed));
}

function accountIdOf(seed: number): AccountId {
  return toAccountId(CHAIN_IDS.SOLANA_DEVNET, addressOf(seed));
}

function encodeConfig(unbondingPeriodSeconds: bigint): string {
  const bytes = getConfigEncoder().encode({
    admin: addressOf(200),
    stakeMint: STAKE_MINT as Address,
    treasury: addressOf(201),
    unbondingPeriodSeconds,
    takeRateBps: 500,
    slashAgentBps: 6_000,
    slashPlatformBps: 3_000,
    slashCapBps: 1_000,
    minimumStake: 100_000_000n,
    penaltyAmount: 1_000_000n,
    verifierDailyCap: 100_000_000n,
    paused: false,
    totalStaked: 0n,
    totalDeposited: 0n,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    bump: 255,
    vaultBump: 254,
    // `Config.redeemer` — the only key `redeem_voucher` accepts as `rent_payer`.
    redeemer: addressOf(202),
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

interface StakeFields {
  readonly bonded?: bigint;
  readonly unbonding?: bigint;
  readonly unbondingStartedAt?: bigint;
}

function encodeStake(provider: Address, fields: StakeFields): string {
  const bonded = fields.bonded ?? 0n;
  const unbonding = fields.unbonding ?? 0n;
  const bytes = getProviderStakeEncoder().encode({
    provider,
    bonded,
    unbonding,
    unbondingStartedAt: fields.unbondingStartedAt ?? 0n,
    slashedInWindow: 0n,
    slashWindowStartedAt: 0n,
    totalDeposited: bonded + unbonding,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    pendingSlash: 0n,
    bump: 253,
  });
  return Buffer.from(bytes).toString('base64');
}

/** The two RPC calls the reader makes, and nothing else. */
class FakeRpc {
  readonly accounts = new Map<string, string>();
  /** How many times `Config` has actually been fetched — the memo assertion. */
  configReads = 0;
  /** Fail the next `getAccountInfo` only. A transient RPC failure, not a dead one. */
  failNextConfigRead = false;

  getAccountInfo(account: Address) {
    return {
      send: async () => {
        this.configReads += 1;
        if (this.failNextConfigRead) {
          this.failNextConfigRead = false;
          throw new Error('rpc unavailable');
        }
        const data = this.accounts.get(account);
        return { value: data ? { data: [data, 'base64'] as const } : null };
      },
    };
  }

  getMultipleAccounts(accounts: readonly Address[]) {
    return {
      send: async () => ({
        value: accounts.map((account) => {
          const data = this.accounts.get(account);
          return data ? { data: [data, 'base64'] as const } : null;
        }),
      }),
    };
  }
}

async function build(
  options: {
    seed?: number;
    stake?: StakeFields;
    unbondingPeriodSeconds?: bigint;
  } = {},
) {
  const rpc = new FakeRpc();
  const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID as Address });
  rpc.accounts.set(
    configPda,
    encodeConfig(options.unbondingPeriodSeconds ?? FOURTEEN_DAYS_SECONDS),
  );

  const seed = options.seed ?? 7;
  const account = accountIdOf(seed);
  if (options.stake) {
    const provider = addressOf(seed);
    const [pda] = await findStakePda({ provider }, { programAddress: PROGRAM_ID as Address });
    rpc.accounts.set(pda, encodeStake(provider, options.stake));
  }

  return { rpc, account, reader: new SolanaSettlementStakeReader(rpc, PROGRAM_ID) };
}

describe('SolanaSettlementStakeReader — three balances, three questions', () => {
  it('decodes bonded and unbonding separately and never sums them', async () => {
    const { reader, account } = await build({
      stake: { bonded: 50_000_000n, unbonding: 10_000_000n },
    });

    const stake = (await reader.bondedStakeOf([account])).get(account);

    // `bonded` alone. Folding `unbonding` in would let a provider request a
    // full unstake and keep serving paid traffic for the whole period.
    expect(stake?.bonded.amount).toBe('50000000');
    expect(stake?.unbonding.amount).toBe('10000000');
  });

  it('denominates both in Config.stake_mint, at the local registry scale', async () => {
    const { reader, account } = await build({ stake: { bonded: 50_000_000n } });

    const stake = (await reader.bondedStakeOf([account])).get(account);

    // The asset comes from the chain (`Config.stake_mint`) and the scale from
    // `asset-registry.ts`, deliberately: a mint whose on-chain decimals differ
    // from the ones we recorded should be loud, not a silent 1000× rescale of
    // somebody's collateral.
    for (const money of [stake?.bonded, stake?.unbonding]) {
      expect(money?.asset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
      expect(money?.decimals).toBe(6);
    }
  });

  it('is absent from the map when there is no stake account at those seeds', async () => {
    // The chain answered, and the answer is "nothing here". An ordinary result
    // with a meaning of its own — never confused with an unreachable RPC.
    const { reader, account } = await build({});

    expect((await reader.bondedStakeOf([account])).has(account)).toBe(false);
  });
});

/**
 * The program writes `0` to every timestamp it has never set, and `0` seconds
 * from the epoch is a date. A screen handed 1970 renders it as a countdown that
 * ran out fifty-six years ago, which for `unbondingCompletesAt` reads as "your
 * unstake is ready to claim".
 */
describe('SolanaSettlementStakeReader — 0 is "never", not 1970', () => {
  it('reports unbondingStartedAt and unbondingCompletesAt as null when nothing is unbonding', async () => {
    const { reader, account } = await build({
      stake: { bonded: 50_000_000n, unbonding: 0n, unbondingStartedAt: 0n },
    });

    const stake = (await reader.bondedStakeOf([account])).get(account);

    expect(stake?.unbondingStartedAt).toBeNull();
    // Not `null + period` either: the completion date is suppressed at the
    // source rather than derived from a zero and then rejected downstream.
    expect(stake?.unbondingCompletesAt).toBeNull();
  });
});

/**
 * `unbondingCompletesAt` is derived here rather than by the caller because the
 * period is a **program parameter** an admin moves with `update_config`. A copy
 * of it in the domain module, or in an env var, is a number that can silently
 * disagree with the one the on-chain withdrawal gate actually enforces — and
 * the direction of that disagreement is a provider told their capital is
 * claimable when the program will refuse.
 */
describe('SolanaSettlementStakeReader — unbondingCompletesAt comes off Config', () => {
  it("adds the program's own period to the start", async () => {
    const { reader, account } = await build({
      stake: { unbonding: 10_000_000n, unbondingStartedAt: UNBONDING_STARTED_AT },
    });

    const stake = (await reader.bondedStakeOf([account])).get(account);

    expect(stake?.unbondingStartedAt?.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    // 14 days later, to the second.
    expect(stake?.unbondingCompletesAt?.toISOString()).toBe('2026-08-29T00:00:00.000Z');
  });

  it('follows the period the chain reports, not a constant', async () => {
    // The same account, read against a Config whose period an admin has
    // shortened to seven days. A hard-coded fortnight would pass the test above
    // and fail here, which is the whole reason the period is read at all.
    const { reader, account } = await build({
      stake: { unbonding: 10_000_000n, unbondingStartedAt: UNBONDING_STARTED_AT },
      unbondingPeriodSeconds: 604_800n,
    });

    const stake = (await reader.bondedStakeOf([account])).get(account);

    expect(stake?.unbondingCompletesAt?.toISOString()).toBe('2026-08-22T00:00:00.000Z');
  });
});

/**
 * `Config` moves only on an admin `update_config`, so it is memoised for the
 * life of the process. The memo holds a **promise**, which is what makes the
 * failure case worth a test of its own: a rejected promise left in the field
 * turns one transient RPC failure at boot into a permanently broken reader,
 * and every subsequent call fails with an error from minutes ago that no
 * amount of retrying can clear.
 */
describe('SolanaSettlementStakeReader — the Config memo', () => {
  it('reads Config once, however many stake reads follow', async () => {
    const { reader, rpc, account } = await build({ stake: { bonded: 50_000_000n } });

    await reader.bondedStakeOf([account]);
    await reader.bondedStakeOf([account]);
    await reader.bondedStakeOf([account]);

    expect(rpc.configReads).toBe(1);
  });

  it('drops the memo on a transient failure, so the next call retries', async () => {
    const { reader, rpc, account } = await build({ stake: { bonded: 50_000_000n } });
    rpc.failNextConfigRead = true;

    await expect(reader.bondedStakeOf([account])).rejects.toThrow('rpc unavailable');

    // The RPC is fine again, and so is the reader — no restart required.
    const stake = (await reader.bondedStakeOf([account])).get(account);
    expect(stake?.bonded.amount).toBe('50000000');
    expect(rpc.configReads).toBe(2);
  });
});
