import { Logger } from '@nestjs/common';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '@modules/provider/ports/chain-enrolment.port';
import {
  ProviderChainStakeKey,
  ProviderStake,
  ProviderStakePort,
  stakeKey,
} from '@modules/provider/ports/provider-stake.port';
import {
  CompositeProviderStakeSource,
  ProviderStakeSourceMode,
} from '@modules/provider/services/composite-provider-stake.source';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The staged cutover from the config stake source to the
 * chain one.
 *
 * ## Why this class exists at all, restated as a test
 *
 * The naive version of the cutover is one line in `ProviderModule`:
 *
 * ```typescript
 * { provide: PROVIDER_STAKE_SOURCE, useExisting: OnChainProviderStakeSource }
 * ```
 *
 * and that one line is a platform-wide outage. A provider who has not signed
 * the payout-proof-style stake-authority challenge has no
 * `stake_authority_account_id` on their enrolment, so the chain source cannot
 * derive a PDA for them and leaves them **absent**.
 * `evaluateStakeGate` turns absent into `STAKE_UNKNOWN` and fails closed, and
 * grace does not save them either — grace opens when a provider is *below the
 * minimum*, never when the stake is *unreadable*. Flipping that binding would
 * therefore take every PAID/FREEMIUM binding of every already-registered
 * provider out of routing, instantly, until each one individually signed.
 *
 * So the swap is staged, and every one of the three stages is asserted here.
 * The suite is deliberately about **which source is consulted for whom** and
 * nothing else: what each source then does with the question is the on-chain
 * source's spec and the router's, and repeating either here would only pin the fakes.
 */

const ASSET = ASSET_IDS.USDC_SOLANA_DEVNET as AssetId;
const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;

function money(atomic: string) {
  return MoneyUtil.of(atomic, ASSET, 6);
}

const OBSERVED_AT = new Date('2026-08-20T10:00:00.000Z');

function reading(providerId: string, chainId: ChainId, atomic: string): ProviderStake {
  return { providerId, chainId, staked: money(atomic), observedAt: OBSERVED_AT };
}

/**
 * A `ProviderStakePort` that answers from a fixed table and records every
 * question it was asked.
 *
 * The recording is the point: most of these tests assert that a source was
 * **not consulted**, which is a stronger and more useful claim than asserting
 * what came back. "The chain was never called" is what makes `mode=config` a
 * safe default rather than a hopeful one.
 */
class RecordingStakeSource implements ProviderStakePort {
  readonly calls: string[][] = [];

  /** Keyed `stakeKey(providerId, chainId)`. */
  constructor(private readonly table: Readonly<Record<string, string>>) {}

  stakeOn(keys: readonly ProviderChainStakeKey[]): Promise<ReadonlyMap<string, ProviderStake>> {
    this.calls.push(keys.map((key) => stakeKey(key.providerId, key.chainId)));
    const found = new Map<string, ProviderStake>();
    for (const { providerId, chainId } of keys) {
      const atomic = this.table[stakeKey(providerId, chainId)];
      if (atomic !== undefined) {
        found.set(stakeKey(providerId, chainId), reading(providerId, chainId, atomic));
      }
    }
    return Promise.resolve(found);
  }

  /** Every `(provider, chain)` pair this source was ever asked about, flattened. */
  get asked(): string[] {
    return this.calls.flat();
  }
}

/** One enrolment as these tests declare it — the row the authority lives on. */
interface Row {
  organizationId: string;
  chainId?: ChainId;
  stakeAuthority: string | null;
}

class ScriptedEnrolments implements ChainEnrolmentPort {
  readonly calls: string[][] = [];

  constructor(private readonly rows: readonly Row[]) {}

  enrolmentsOf(providerIds: readonly string[]): Promise<ReadonlyMap<string, ChainEnrolment>> {
    this.calls.push([...providerIds]);
    const found = new Map<string, ChainEnrolment>();
    for (const row of this.rows) {
      if (!providerIds.includes(row.organizationId)) continue;
      const chainId = row.chainId ?? DEVNET;
      found.set(enrolmentKey(row.organizationId, chainId), {
        providerId: row.organizationId,
        chainId,
        payoutAccountId: `${chainId}:PAYOUT` as AccountId,
        stakeAuthorityAccountId: (row.stakeAuthority as AccountId | null) ?? null,
        status: ChainEnrolmentStatus.ACTIVE,
        enrolledAt: OBSERVED_AT,
      });
    }
    return Promise.resolve(found);
  }
}

function build(options: {
  mode: string | null;
  rows?: readonly Row[];
  config?: Readonly<Record<string, string>>;
  chain?: Readonly<Record<string, string>>;
}) {
  const config = new RecordingStakeSource(options.config ?? {});
  const chain = new RecordingStakeSource(options.chain ?? {});
  const enrolments = new ScriptedEnrolments(options.rows ?? []);

  const source = new CompositeProviderStakeSource(options.mode, config, chain, enrolments);

  return { source, config, chain, enrolments };
}

/** `stakeOn` for one provider on the default chain — the shape most cases want. */
function on(providerId: string, chainId: ChainId = DEVNET): ProviderChainStakeKey {
  return { providerId, chainId };
}

describe('CompositeProviderStakeSource', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('mode=config', () => {
    it('mode=config never consults the chain', async () => {
      const { source, config, chain, enrolments } = build({
        mode: ProviderStakeSourceMode.CONFIG,
        rows: [{ organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` }],
        config: { [stakeKey('org-1', DEVNET)]: '50000000' },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      const result = await source.stakeOn([on('org-1')]);

      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('50000000');
      expect(chain.calls).toHaveLength(0);
      // Not even the enrolment lookup runs: in this mode there is nothing to
      // partition, and a routing decision must not pay for a query it cannot use.
      expect(enrolments.calls).toHaveLength(0);
      expect(config.asked).toEqual([stakeKey('org-1', DEVNET)]);
    });

    it('defaults to config when PROVIDER_STAKE_SOURCE_MODE is unset', async () => {
      const { source, config, chain } = build({
        mode: null,
        rows: [{ organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` }],
        config: { [stakeKey('org-1', DEVNET)]: '50000000' },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      // Merging the cutover must change no production behaviour. Promotion is a
      // decision a human makes after the gap report is empty, never a default
      // that drifts in with a deploy.
      expect(source.mode).toBe(ProviderStakeSourceMode.CONFIG);

      const result = await source.stakeOn([on('org-1')]);
      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('50000000');
      expect(chain.calls).toHaveLength(0);
      expect(config.asked).toEqual([stakeKey('org-1', DEVNET)]);
    });
  });

  describe('mode=chain_with_config_fallback', () => {
    it('mode=chain_with_config_fallback reads chain for a provider with a proved authority', async () => {
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [{ organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` }],
        config: { [stakeKey('org-1', DEVNET)]: '50000000' },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      const result = await source.stakeOn([on('org-1')]);

      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('99000000');
      expect(chain.asked).toEqual([stakeKey('org-1', DEVNET)]);
      // The config number must not even be *read* for a provider the chain can
      // answer for. It is an operator-typed claim about collateral, and the
      // whole point of on-chain stake is that it stops being consulted.
      expect(config.asked).not.toContain(stakeKey('org-1', DEVNET));
    });

    it('mode=chain_with_config_fallback falls back to config for a provider without one', async () => {
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [
          { organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` },
          { organizationId: 'org-2', stakeAuthority: null },
        ],
        config: {
          [stakeKey('org-1', DEVNET)]: '50000000',
          [stakeKey('org-2', DEVNET)]: '60000000',
        },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      const result = await source.stakeOn([on('org-1'), on('org-2')]);

      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('99000000');
      expect(result.get(stakeKey('org-2', DEVNET))?.staked.amount).toBe('60000000');
      expect(chain.asked).toEqual([stakeKey('org-1', DEVNET)]);
      expect(config.asked).toEqual([stakeKey('org-2', DEVNET)]);
    });

    it('falls back for a provider with no registration row at all', async () => {
      // No row is the same situation as a null `stake_authority` — nothing to
      // derive a PDA from — and must not be a third behaviour.
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [],
        config: { [stakeKey('org-9', DEVNET)]: '60000000' },
        chain: {},
      });

      const result = await source.stakeOn([on('org-9')]);

      expect(result.get(stakeKey('org-9', DEVNET))?.staked.amount).toBe('60000000');
      expect(chain.calls).toHaveLength(0);
      expect(config.asked).toEqual([stakeKey('org-9', DEVNET)]);
    });

    it('logs every fallback with the providerId', async () => {
      // A silent fallback lives forever, because nobody can see it carrying the
      // load. The gap report answers "who is left"; this line answers "and they
      // are still being served off the config number right now".
      const { source } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [{ organizationId: 'org-1', stakeAuthority: null }],
        config: { [stakeKey('org-1', DEVNET)]: '50000000' },
      });

      await source.stakeOn([on('org-1')]);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('org-1'));
    });

    it('logs the fallback even when config has no number for the provider either', async () => {
      // Absent from both sources is the worst case for that provider — the gate
      // will refuse them — and it is the one an operator most needs to see.
      const { source } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [{ organizationId: 'org-7', stakeAuthority: null }],
        config: {},
      });

      const result = await source.stakeOn([on('org-7')]);

      expect(result.has(stakeKey('org-7', DEVNET))).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('org-7'));
    });

    it('does NOT fall back to config when a proved provider is unreadable on chain', async () => {
      // The decision this suite exists to pin down.
      //
      // `OnChainProviderStakeSource` returns "absent" for a proved provider in
      // two situations that it deliberately does not distinguish: the chain
      // answered and there is no stake account, and the RPC has been failing
      // for longer than `STAKE_STALE_MAX_MS`. Falling back to config for either
      // would mean an operator-typed number outranking a chain that said "no" —
      // which is exactly the substitution on-chain stake exists to remove, and it would
      // keep a provider who closed or lost their stake account taking paid
      // traffic indefinitely.
      //
      // So a proved authority is a one-way door: once a provider has signed for
      // a stake account, the chain is the only thing that speaks for them.
      // Absent, and the gate refuses — fail closed, which is the correct
      // outcome when the collateral behind a paid call cannot be established.
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [{ organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` }],
        config: { [stakeKey('org-1', DEVNET)]: '50000000' },
        chain: {},
      });

      const result = await source.stakeOn([on('org-1')]);

      expect(result.has(stakeKey('org-1', DEVNET))).toBe(false);
      expect(chain.asked).toEqual([stakeKey('org-1', DEVNET)]);
      expect(config.asked).not.toContain(stakeKey('org-1', DEVNET));
    });

    it('partitions per (provider, chain), not per provider', async () => {
      // The degenerate this kills: a partition keyed on the PROVIDER. One
      // provider, two enrolments, an authority proved on exactly one of them —
      // so the two chains must go to two different sources. A provider-level
      // partition sends both to the chain source (the provider "has proved
      // one"), and mainnet, which the chain cannot answer for, goes dark
      // instead of falling back. Every other case in this file has one chain
      // per provider and cannot tell the two apart.
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
        rows: [
          { organizationId: 'org-1', chainId: DEVNET, stakeAuthority: `${DEVNET}:AUTH1` },
          { organizationId: 'org-1', chainId: MAINNET, stakeAuthority: null },
        ],
        config: {
          [stakeKey('org-1', DEVNET)]: '50000000',
          [stakeKey('org-1', MAINNET)]: '60000000',
        },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      const result = await source.stakeOn([on('org-1', DEVNET), on('org-1', MAINNET)]);

      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('99000000');
      expect(result.get(stakeKey('org-1', MAINNET))?.staked.amount).toBe('60000000');
      expect(chain.asked).toEqual([stakeKey('org-1', DEVNET)]);
      expect(config.asked).toEqual([stakeKey('org-1', MAINNET)]);
    });
  });

  describe('mode=chain', () => {
    it('mode=chain omits a provider without a proved authority — no fallback', async () => {
      const { source, config, chain } = build({
        mode: ProviderStakeSourceMode.CHAIN,
        rows: [
          { organizationId: 'org-1', stakeAuthority: `${DEVNET}:AUTH1` },
          { organizationId: 'org-2', stakeAuthority: null },
        ],
        config: {
          [stakeKey('org-1', DEVNET)]: '50000000',
          [stakeKey('org-2', DEVNET)]: '60000000',
        },
        chain: { [stakeKey('org-1', DEVNET)]: '99000000' },
      });

      const result = await source.stakeOn([on('org-1'), on('org-2')]);

      expect(result.get(stakeKey('org-1', DEVNET))?.staked.amount).toBe('99000000');
      expect(result.has(stakeKey('org-2', DEVNET))).toBe(false);
      expect(config.calls).toHaveLength(0);
      // Everyone is handed to the chain source unfiltered: it already drops a
      // provider with no proved authority, and that is precisely this mode's
      // definition of absent. Pre-filtering here would buy a second query and
      // change nothing.
      expect(chain.asked).toEqual([stakeKey('org-1', DEVNET), stakeKey('org-2', DEVNET)]);
    });
  });

  describe('construction', () => {
    it('rejects an unrecognised mode at construction rather than silently picking one', () => {
      // A typo'd env value must not resolve to the permissive mode. `chain` and
      // `config` differ by an outage in one direction and by unbacked paid
      // traffic in the other; neither is a reasonable thing to inherit from a
      // misspelling.
      expect(() => build({ mode: 'chain_with_fallback' })).toThrow(/PROVIDER_STAKE_SOURCE_MODE/);
      expect(() => build({ mode: 'chain_with_fallback' })).toThrow(/chain_with_config_fallback/);
    });

    it('accepts a mode with surrounding whitespace or different casing', () => {
      // `.env` files collect trailing spaces, and neither of those is a
      // different decision.
      expect(build({ mode: '  CHAIN  ' }).source.mode).toBe(ProviderStakeSourceMode.CHAIN);
      expect(build({ mode: '' }).source.mode).toBe(ProviderStakeSourceMode.CONFIG);
    });
  });

  it('asks nothing at all for an empty candidate set', async () => {
    const { source, config, chain, enrolments } = build({
      mode: ProviderStakeSourceMode.CHAIN_WITH_CONFIG_FALLBACK,
    });

    expect((await source.stakeOn([])).size).toBe(0);
    expect(config.calls).toHaveLength(0);
    expect(chain.calls).toHaveLength(0);
    expect(enrolments.calls).toHaveLength(0);
  });
});
