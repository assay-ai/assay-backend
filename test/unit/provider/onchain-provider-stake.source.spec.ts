import { Address, getAddressDecoder } from '@solana/kit';
import {
  findConfigPda,
  findStakePda,
  getConfigEncoder,
  getProviderStakeEncoder,
} from '@assay/settlement-client';

import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import {
  AccountId,
  CHAIN_IDS,
  ChainId,
  parseAssetId,
  toAccountId,
} from '@modules/chains/ports/caip.types';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import {
  MAX_ACCOUNTS_PER_RPC_BATCH,
  SolanaSettlementStakeReader,
} from '@modules/chains/solana/settlement-stake-reader.service';
import {
  STAKE_CACHE_TTL_MS,
  STAKE_STALE_MAX_MS,
} from '@modules/provider/constants/onchain-stake.constants';
import {
  OnChainProviderStakeSource,
  StakeReadingCache,
} from '@modules/provider/services/onchain-provider-stake.source';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The on-chain stake reader, end to end from a provider id to a
 * `Money`, with the RPC and Redis faked at the seams the production code
 * already declares.
 *
 * The fake sits at the **RPC** rather than at `OnChainStakeReaderPort`, so the
 * account bytes are encoded by the generated client and decoded by the real
 * decoder. A fake reader would have made every assertion about `bonded` a
 * restatement of the fake, which is precisely the decision this suite exists to
 * pin down.
 */

const PROGRAM_ID = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S';
const STAKE_MINT = parseAssetId(ASSET_IDS.USDC_SOLANA_DEVNET).assetReference;

/** A deterministic, valid 32-byte address. */
function addressOf(seed: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(seed));
}

function accountIdOf(seed: number): AccountId {
  return toAccountId(CHAIN_IDS.SOLANA_DEVNET, addressOf(seed));
}

function encodeConfig(): string {
  const bytes = getConfigEncoder().encode({
    admin: addressOf(200),
    stakeMint: STAKE_MINT as Address,
    treasury: addressOf(201),
    unbondingPeriodSeconds: 1_209_600n,
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

function encodeStake(provider: Address, bonded: bigint, unbonding: bigint): string {
  const bytes = getProviderStakeEncoder().encode({
    provider,
    bonded,
    unbonding,
    unbondingStartedAt: 0n,
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
  /** One entry per `getMultipleAccounts` call — the batching assertion reads this. */
  readonly batches: string[][] = [];
  singleCalls = 0;
  failing = false;
  /**
   * Keep only this many entries of the next batched reply — a node that answers
   * for fewer accounts than it was asked about. Not a scenario the client can
   * produce on purpose, which is the point: it is what a malformed or truncated
   * reply looks like from here.
   */
  truncateTo: number | null = null;

  getAccountInfo(account: Address) {
    return {
      send: async () => {
        this.singleCalls += 1;
        if (this.failing) throw new Error('rpc unavailable');
        const data = this.accounts.get(account);
        return { value: data ? { data: [data, 'base64'] as const } : null };
      },
    };
  }

  getMultipleAccounts(accounts: readonly Address[]) {
    return {
      send: async () => {
        this.batches.push([...accounts]);
        if (this.failing) throw new Error('rpc unavailable');
        const entries = accounts.map((account) => {
          const data = this.accounts.get(account);
          return data ? { data: [data, 'base64'] as const } : null;
        });
        return { value: this.truncateTo === null ? entries : entries.slice(0, this.truncateTo) };
      },
    };
  }
}

/**
 * Redis, in memory.
 *
 * TTLs are **recorded and not enforced**, on purpose. If this expired entries
 * itself, the "older than `STAKE_STALE_MAX_MS`" test would pass because the key
 * vanished rather than because the source checked the reading's age — and the
 * age check is the half that survives a Redis whose clock, eviction policy or
 * TTL argument is wrong. `ttls` is asserted separately.
 */
class FakeCache implements StakeReadingCache {
  readonly values = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();

  get<T>(key: string): Promise<T | null> {
    const raw = this.values.get(key);
    return Promise.resolve(raw === undefined ? null : (JSON.parse(raw) as T));
  }

  set<T>(key: string, value: T, ttl?: number): Promise<void> {
    this.values.set(key, JSON.stringify(value));
    this.ttls.set(key, ttl);
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.values.delete(key);
    this.ttls.delete(key);
    return Promise.resolve();
  }
}

interface Row {
  readonly organizationId: string;
  readonly chainId?: ChainId;
  readonly stakeAuthority: string | null;
}

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

/** The enrolments the source resolves stake authorities through. */
class ScriptedEnrolments implements ChainEnrolmentPort {
  readonly asked: string[][] = [];

  constructor(private readonly rows: readonly Row[]) {}

  enrolmentsOf(providerIds: readonly string[]): Promise<ReadonlyMap<string, ChainEnrolment>> {
    this.asked.push([...providerIds]);
    const found = new Map<string, ChainEnrolment>();
    for (const row of this.rows) {
      if (!providerIds.includes(row.organizationId)) continue;
      const chainId = row.chainId ?? DEVNET;
      found.set(enrolmentKey(row.organizationId, chainId), {
        providerId: row.organizationId,
        chainId,
        payoutAccountId: toAccountId(chainId, addressOf(1)),
        stakeAuthorityAccountId: (row.stakeAuthority as AccountId | null) ?? null,
        status: ChainEnrolmentStatus.ACTIVE,
        enrolledAt: new Date(0),
      });
    }
    return Promise.resolve(found);
  }
}

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

/**
 * One clock, not two.
 *
 * `observedAt` is stamped by the reader off the wall clock — it is the moment
 * the chain answered — while the staleness budget is measured by the source's
 * injected `now`. Faking the system time is what keeps those the same clock;
 * injecting a second one into the test would let a reading be "aged" without
 * its timestamp moving, and the suite would then pass for a source that
 * compared the two incorrectly.
 */
beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
});

afterEach(() => {
  jest.useRealTimers();
});

function build(rows: readonly Row[]) {
  const rpc = new FakeRpc();
  const cache = new FakeCache();
  const enrolments = new ScriptedEnrolments(rows);

  const reader = new SolanaSettlementStakeReader(rpc, PROGRAM_ID);
  const source = new OnChainProviderStakeSource(reader, enrolments, cache, {
    freshTtlMs: STAKE_CACHE_TTL_MS,
    staleMaxMs: STAKE_STALE_MAX_MS,
    now: () => Date.now(),
  });

  return { source, rpc, cache, enrolments };
}

/** One `(provider, chain)` question, defaulting to the chain every row uses. */
function on(providerId: string, chainId: ChainId = DEVNET) {
  return { providerId, chainId };
}

async function seed(
  rpc: FakeRpc,
  stakes: readonly { seed: number; bonded: bigint; unbonding: bigint }[],
) {
  const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID as Address });
  rpc.accounts.set(configPda, encodeConfig());

  for (const stake of stakes) {
    const provider = addressOf(stake.seed);
    const [pda] = await findStakePda({ provider }, { programAddress: PROGRAM_ID as Address });
    rpc.accounts.set(pda, encodeStake(provider, stake.bonded, stake.unbonding));
  }
}

describe('OnChainProviderStakeSource — what counts as stake', () => {
  it('reads bonded ALONE, never bonded + unbonding', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: accountIdOf(7) }]);
    await seed(rpc, [{ seed: 7, bonded: 100n, unbonding: 900n }]);

    const stake = (await source.stakeOn([on('org-1')])).get(stakeKey('org-1', DEVNET));

    // 100, not 1000. Stake the provider has asked to take out is not backing
    // anybody's traffic, even though it is still slashable.
    expect(stake?.staked.amount).toBe('100');
    expect(stake?.staked.asset).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
    expect(stake?.staked.decimals).toBe(6);
  });
});

describe('OnChainProviderStakeSource — absent is not zero', () => {
  it('omits a provider that has not proved a stake authority', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: null }]);
    await seed(rpc, []);

    const stakes = await source.stakeOn([on('org-1')]);

    // Absent from the map, not `0`. The gate refuses both, but only one of
    // them means "our source is down" — and the receipt has to be able to say
    // which.
    expect(stakes.has(stakeKey('org-1', DEVNET))).toBe(false);
    // Nothing to look up, so nothing is asked of the chain.
    expect(rpc.batches).toHaveLength(0);
  });

  it('omits the chain the provider is NOT enrolled on, and answers the one they are', async () => {
    // The degenerate this kills: a `stakeOn` that takes the providers out of
    // its keys and ignores the chains, then files every reading under whatever
    // chain it was handed. Here the provider is bonded on devnet and has no
    // mainnet enrolment at all, so mainnet must be ABSENT — not devnet's 500
    // wearing a mainnet key, which would route a mainnet call against
    // collateral mainnet cannot see.
    const { source, rpc } = build([
      { organizationId: 'org-1', chainId: DEVNET, stakeAuthority: accountIdOf(7) },
    ]);
    await seed(rpc, [{ seed: 7, bonded: 500n, unbonding: 0n }]);

    const stakes = await source.stakeOn([on('org-1', DEVNET), on('org-1', MAINNET)]);

    expect(stakes.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('500');
    expect(stakes.has(stakeKey('org-1', MAINNET))).toBe(false);
    // And the reading says which chain it is about, so a map built with the
    // wrong key is detectable rather than merely wrong.
    expect(stakes.get(stakeKey('org-1', DEVNET))?.chainId).toBe(DEVNET);
  });

  it('omits a provider whose stake PDA does not exist on chain', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: accountIdOf(9) }]);
    await seed(rpc, []);

    const stakes = await source.stakeOn([on('org-1')]);

    expect(stakes.has(stakeKey('org-1', DEVNET))).toBe(false);
    expect(rpc.batches).toHaveLength(1);
  });
});

describe('OnChainProviderStakeSource — degrading when the RPC fails', () => {
  it('serves the last good reading when the RPC fails, up to STAKE_STALE_MAX_MS', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: accountIdOf(7) }]);
    await seed(rpc, [{ seed: 7, bonded: 500n, unbonding: 0n }]);

    expect(
      (await source.stakeOn([on('org-1')])).get(stakeKey('org-1', DEVNET))?.staked.amount,
    ).toBe('500');

    rpc.failing = true;
    jest.setSystemTime(T0 + STAKE_STALE_MAX_MS - 1_000);

    const stake = (await source.stakeOn([on('org-1')])).get(stakeKey('org-1', DEVNET));

    expect(stake?.staked.amount).toBe('500');
    // The gate fails closed, so reading straight through would take every paid
    // binding out of routing on one timeout.
    expect(stake?.observedAt.getTime()).toBe(T0);
  });

  it('drops to absent once the last good reading is older than STAKE_STALE_MAX_MS', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: accountIdOf(7) }]);
    await seed(rpc, [{ seed: 7, bonded: 500n, unbonding: 0n }]);

    await source.stakeOn([on('org-1')]);

    rpc.failing = true;
    jest.setSystemTime(T0 + STAKE_STALE_MAX_MS + 1);

    // Both sides of the degrade are tested. A tolerant side on its own lets
    // "degrade" quietly become "never fails closed", which would keep a slashed
    // provider routable for as long as the RPC stays down.
    expect((await source.stakeOn([on('org-1')])).has(stakeKey('org-1', DEVNET))).toBe(false);
  });

  it('writes the cache entry with a TTL no longer than the staleness budget', async () => {
    const { source, rpc, cache } = build([
      { organizationId: 'org-1', stakeAuthority: accountIdOf(7) },
    ]);
    await seed(rpc, [{ seed: 7, bonded: 500n, unbonding: 0n }]);

    await source.stakeOn([on('org-1')]);

    const ttls = [...cache.ttls.values()];
    expect(ttls).toHaveLength(1);
    expect(ttls[0]).toBe(Math.ceil(STAKE_STALE_MAX_MS / 1000));
  });
});

describe('OnChainProviderStakeSource — what observedAt means', () => {
  it('stamps observedAt with the CHAIN read, not the cache read', async () => {
    const { source, rpc } = build([{ organizationId: 'org-1', stakeAuthority: accountIdOf(7) }]);
    await seed(rpc, [{ seed: 7, bonded: 500n, unbonding: 0n }]);

    await source.stakeOn([on('org-1')]);

    jest.setSystemTime(T0 + STAKE_CACHE_TTL_MS - 1_000);
    const stake = (await source.stakeOn([on('org-1')])).get(stakeKey('org-1', DEVNET));

    // Served from cache — no second chain read — and the timestamp still names
    // the moment the chain was read. A cached value is a claim about the past,
    // and the gate is about to make a money decision with it.
    expect(rpc.batches).toHaveLength(1);
    expect(stake?.observedAt.getTime()).toBe(T0);
  });
});

describe('OnChainProviderStakeSource — one round trip, not N', () => {
  it('batches — one getMultipleAccounts for N providers, not N calls', async () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      organizationId: `org-${index}`,
      stakeAuthority: accountIdOf(index + 20),
    }));
    const { source, rpc } = build(rows);
    await seed(
      rpc,
      rows.map((_, index) => ({ seed: index + 20, bonded: 100n, unbonding: 0n })),
    );

    const stakes = await source.stakeOn(rows.map((row) => on(row.organizationId)));

    expect(stakes.size).toBe(12);
    // A per-provider call would turn one routing decision into N sequential
    // chain reads on the path an agent is blocked on.
    expect(rpc.batches).toHaveLength(1);
    expect(rpc.batches[0]).toHaveLength(12);
  });

  it('splits at the RPC ceiling rather than sending one oversized request', async () => {
    const count = MAX_ACCOUNTS_PER_RPC_BATCH + 1;
    const rows = Array.from({ length: count }, (_, index) => ({
      organizationId: `org-${index}`,
      stakeAuthority: accountIdOf(index + 20),
    }));
    const { source, rpc } = build(rows);
    await seed(
      rpc,
      rows.map((_, index) => ({ seed: index + 20, bonded: 100n, unbonding: 0n })),
    );

    const stakes = await source.stakeOn(rows.map((row) => on(row.organizationId)));

    // `getMultipleAccounts` refuses more than 100 addresses outright rather
    // than truncating, so the 101st provider is not a slow path — it is an
    // error that would take the whole routing decision with it.
    expect(stakes.size).toBe(count);
    expect(rpc.batches.map((batch) => batch.length)).toEqual([MAX_ACCOUNTS_PER_RPC_BATCH, 1]);
  });
});

/**
 * `getMultipleAccounts` answers **positionally**, and the reader zips the reply
 * back onto the addresses it sent. A short reply therefore does not look
 * truncated — the accounts that fell off the end look like accounts that do not
 * exist, and "no account at those seeds" is an ordinary answer with a meaning
 * of its own.
 *
 * That meaning is the problem. The stake-authority rotation gate reads it as "this
 * provider has fully exited their stake account", and lets them re-point their
 * stake authority at a fresh PDA — which is precisely the substitution that
 * gate exists to forbid, since a slash would then follow the new key to an
 * empty account while the collateral stays behind. Unreadable must never be
 * able to resolve to empty, so the reader refuses a reply it cannot line up
 * rather than zipping what it got.
 */
describe('SolanaSettlementStakeReader — a short RPC reply is not an empty stake account', () => {
  it('throws instead of reading the missing entries as "no stake account"', async () => {
    const rpc = new FakeRpc();
    await seed(rpc, [
      { seed: 7, bonded: 500n, unbonding: 0n },
      { seed: 8, bonded: 900n, unbonding: 0n },
    ]);
    // The node answers for the first address and drops the second.
    rpc.truncateTo = 1;
    const reader = new SolanaSettlementStakeReader(rpc, PROGRAM_ID);

    await expectErrorCodeAsync(
      () => reader.bondedStakeOf([accountIdOf(7), accountIdOf(8)]),
      ChainErrorCode.CHAIN_RPC_REPLY_MALFORMED,
    );
  });
});
