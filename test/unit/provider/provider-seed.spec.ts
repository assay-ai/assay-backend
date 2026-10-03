import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { stakeKey } from '@modules/provider/ports/provider-stake.port';
import { loadProviderStakes } from '@modules/provider/services/provider-seed';

/**
 * `PROVIDER_STAKE_SEED_FILE` — the loader, and the five refusals it is made of.
 *
 * ## Why every one of these is a test rather than a comment
 *
 * This file is read by a `useFactory` in `ProviderModule` with no condition on
 * it, so a file it refuses does not degrade a feature — it fails the DI graph of
 * **every** process (api, scheduler, worker), whatever
 * `PROVIDER_STAKE_SOURCE_MODE` says. That is the intended behaviour: `loadRecord`'s
 * house rule is that "nothing is configured" must not be how "your configuration
 * did not load" presents itself. But a boot-time guard nobody has ever seen fire
 * is indistinguishable from one that was written wrong, and until this file the
 * five throws per-chain stake added had **zero** tests — a review degenerate disabled
 * the asset/chain consistency check outright and the whole suite stayed green.
 *
 * The consistency check is the load-bearing one. A reading denominated in Solana
 * USDC but filed under `eip155:4663` would be accepted by the snapshot, handed to
 * the gate, and refused at request time as `STAKE_UNKNOWN` — which reads as an RPC
 * outage. Catching it at boot is the difference between an operator fixing a typo
 * and an operator paging a chain team.
 *
 * ## Two Solana chain ids and no EVM
 *
 * The loader validates CAIP grammar and cross-checks an asset's own chain against
 * the row's. Devnet and mainnet state that exactly as well as an EVM id would.
 */

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;
const MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const DEVNET_USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const MAINNET_USDC = ASSET_IDS.USDC_SOLANA_MAINNET;

const PROVIDER = 'a965eec3-ad93-4257-bf9b-e172361ee56c';

const dir = mkdtempSync(join(tmpdir(), 'provider-seed-'));
let counter = 0;

/** Writes `content` to a fresh path and returns it. Never reuses a name. */
function seedFile(content: unknown): string {
  counter += 1;
  const path = join(dir, `stakes-${counter}.json`);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  return path;
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    providerId: PROVIDER,
    chainId: DEVNET,
    amount: '500000000',
    asset: DEVNET_USDC,
    decimals: 6,
    ...overrides,
  };
}

describe('loadProviderStakes — what it accepts', () => {
  it('keys the snapshot on (provider, chain), so one provider can be seeded on two chains', async () => {
    const path = seedFile([
      entry(),
      entry({ chainId: MAINNET, asset: MAINNET_USDC, amount: '200000000' }),
    ]);

    const snapshot = loadProviderStakes(path);

    expect(snapshot[stakeKey(PROVIDER, DEVNET)]).toEqual({
      amount: '500000000',
      asset: DEVNET_USDC,
      decimals: 6,
    });
    expect(snapshot[stakeKey(PROVIDER, MAINNET)]).toMatchObject({ amount: '200000000' });
  });

  it('yields an empty snapshot when the variable is unset — configured nothing, not broken', async () => {
    // The default argument reads `process.env.PROVIDER_STAKE_SEED_FILE`, which
    // this repo's `.env` sets, so the variable has to be cleared to ask the
    // question. An unset variable means "no operator seeded anything", which is
    // a legitimate deployment and must not throw.
    const previous = process.env.PROVIDER_STAKE_SEED_FILE;
    delete process.env.PROVIDER_STAKE_SEED_FILE;
    try {
      expect(loadProviderStakes()).toEqual({});
    } finally {
      if (previous === undefined) delete process.env.PROVIDER_STAKE_SEED_FILE;
      else process.env.PROVIDER_STAKE_SEED_FILE = previous;
    }
  });

  it('accepts the repo’s own committed seed file — the one .env points at', async () => {
    // A regression trap on `scripts/mcp/seed/stakes.json` itself: it is a
    // tracked file this commit converted to the array shape, and it is the only
    // file in the repo the loader actually reads on a local boot. If somebody
    // edits it back into an object, this goes red here rather than at boot.
    const snapshot = loadProviderStakes('scripts/mcp/seed/stakes.json');

    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    for (const key of Object.keys(snapshot)) expect(key).toContain('|');
  });
});

describe('loadProviderStakes — what it refuses, at boot', () => {
  it('refuses a JSON object, the shape the file had before per-chain stake', async () => {
    // The old format keyed by provider id. It cannot express a pair, and
    // accepting it would silently seed nothing — every provider absent, every
    // paid binding refused, and nothing in the logs disagreeing.
    const path = seedFile({ [PROVIDER]: { amount: '1', asset: DEVNET_USDC, decimals: 6 } });

    expect(() => loadProviderStakes(path)).toThrow(/must contain a JSON array/);
  });

  it('refuses an entry with no providerId', async () => {
    const path = seedFile([{ ...entry(), providerId: undefined }]);

    expect(() => loadProviderStakes(path)).toThrow(/has no providerId/);
  });

  it('refuses a chainId that is not CAIP-2', async () => {
    const path = seedFile([entry({ chainId: 'devnet' })]);

    expect(() => loadProviderStakes(path)).toThrow(/malformed chainId/);
  });

  it('refuses an asset that is not CAIP-19', async () => {
    const path = seedFile([entry({ asset: 'USDC' })]);

    expect(() => loadProviderStakes(path)).toThrow(/malformed asset/);
  });

  it('refuses a reading filed under a chain its own asset does not name', async () => {
    // THE one. A well-formed chain id, a well-formed asset id, and they
    // disagree — which no grammar check can see. Collateral is only reachable
    // by the settlement contract of its own chain, so this row is a claim about
    // money that cannot be taken, and the gate would report it as
    // `STAKE_UNKNOWN` at request time: an operator would go and check the RPC.
    const path = seedFile([entry({ chainId: MAINNET, asset: DEVNET_USDC })]);

    expect(() => loadProviderStakes(path)).toThrow(/denominated in/);
    expect(() => loadProviderStakes(path)).toThrow(/collateral is only reachable/);
  });

  it('refuses a non-integer amount', async () => {
    const path = seedFile([entry({ amount: '1.5' })]);

    expect(() => loadProviderStakes(path)).toThrow(/non-integer amount/);
  });

  it('refuses malformed decimals', async () => {
    const path = seedFile([entry({ decimals: -1 })]);

    expect(() => loadProviderStakes(path)).toThrow(/malformed decimals/);
  });

  it('refuses the same (provider, chain) twice — one reading per pair', async () => {
    // Two rows for one pair is an operator disagreeing with themselves, and
    // last-write-wins would resolve it silently in file order.
    const path = seedFile([entry(), entry({ amount: '999' })]);

    expect(() => loadProviderStakes(path)).toThrow(/repeats provider/);
  });

  it('names the entry index and the provider, so a 200-line file is greppable', async () => {
    const path = seedFile([entry(), entry({ chainId: 'devnet' })]);

    expect(() => loadProviderStakes(path)).toThrow(/entry 1/);
    expect(() => loadProviderStakes(path)).toThrow(new RegExp(PROVIDER));
  });
});
