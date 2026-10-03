import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ReconciliationJob } from '@modules/settlement/jobs/reconciliation.job';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';

const SRC = join(__dirname, '../../../src');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/**
 * One forbidden shape, with the two examples that prove the regex is neither
 * vacuous nor a word-grep.
 *
 * `positive` is a minimal source line that IS the violation; `negative` is
 * prose or ordinary per-chain code that must NOT trip it. Both live on the rule
 * rather than in a lookup table beside it, because a table keyed by `name` goes
 * silently empty the day somebody renames a rule — and `pattern.test(undefined)`
 * tests the string `"undefined"`, which passes.
 */
interface ForbiddenShape {
  readonly name: string;
  readonly pattern: RegExp;
  readonly positive: string;
  readonly negative: string;
}

/**
 * The chains are independent, and nothing may assert otherwise.
 *
 * The two chains are treated as independent and separate so the code and logic
 * stay simple: one chain does not need to know about the other.
 *
 * The consequences:
 *
 * - No reconciler check that sums both chains.
 * - No test that requires the two `Config`s to agree.
 * - No alert on divergence between them.
 * - Take rates are independent and free to drift: nothing may compute a
 *   platform-wide take rate, and any dashboard showing "the" take rate is wrong
 *   — it shows one per chain or it shows nothing.
 * - Removing one chain from `ENABLED_CHAINS` must leave the other entirely
 *   unaffected, including its reconciler, its scheduler sweeps and its
 *   metrics. If turning off Solana perturbs anything on the EVM chain, the
 *   independence is not real and that is a defect.
 *
 * ## Why a source lock
 *
 * There is no input that makes a MISSING cross-chain assertion observable, and
 * with one chain enabled a sum over two chains and a read of one chain return
 * the same number. The defect becomes visible on the day the second chain goes
 * live, which is the day it costs the most. A source-level guard is the only
 * one that reaches code nobody has written yet.
 *
 * ## And why the patterns are narrow
 *
 * Each pattern below names a SHAPE that can only be a cross-chain assertion,
 * not a word that might appear in a comment. A broad grep would be tripped by
 * prose and would be relaxed, and a relaxed guard is worse than none. The
 * `negative` on every rule is what holds that claim to account.
 */
describe('no cross-chain invariant', () => {
  const sources = walk(SRC).filter((f) => f.endsWith('.ts') && !f.includes('/_examples/'));

  const forbidden: readonly ForbiddenShape[] = [
    {
      // A reduce/sum whose subject is a COLLECTION OF CHAINS.
      name: 'a sum across chains',
      pattern:
        /\b(?:enabledChains|chains|chainIds)\b[^\n;]{0,80}\.(?:reduce|flatMap)\([^\n]{0,120}(?:\+|sum|total)/i,
      positive: 'const t = enabledChains.reduce((a, c) => a + balanceOf(c), 0n);',
      // The reconciler's own work list: a flatMap over the enabled chains that
      // collects each chain's assets and adds nothing. This is the legal shape,
      // and it is the shape most likely to be over-matched by a lazier regex.
      negative: 'const assets = this.chains.enabledChains().flatMap((c) => assetsOf(c));',
    },
    {
      // Any assertion that two chains' parameters agree.
      name: 'an equality assertion between two chains',
      pattern: /\b(?:assert|expect|require|invariant)\w*\([^\n]{0,120}\bchain[AB1-2]\b/i,
      positive: 'assert(chainA.takeRateBps === chainB.takeRateBps);',
      negative: 'expect(report.chainId).toEqual(CHAIN_IDS.SOLANA_DEVNET);',
    },
    {
      // A platform-wide take rate. There is one per chain or there is none.
      name: 'a platform-wide take rate',
      pattern: /\b(?:platformTakeRate|globalTakeRate|takeRateAcrossChains|combinedTakeRate)\b/,
      positive: 'const platformTakeRate = 250;',
      negative: 'const takeRateBps = config.takeRateBpsFor(chainId);',
    },
    {
      name: 'an alert on cross-chain divergence',
      pattern: /\b(?:chainDivergence|crossChainDrift|chainsDisagree|configsDiverged)\b/i,
      positive: 'page("chainDivergence");',
      negative: '// the two chains may diverge freely; nothing alerts on it',
    },
    {
      name: 'a unified or combined balance',
      pattern: /\b(?:unifiedBalance|combinedBalance|totalAcrossChains|aggregateBalance)\b/i,
      positive: 'const unifiedBalance = a + b;',
      negative: '// balances are per chain and are never combined',
    },
    {
      // No bridging between chains, stated as a deletion. None may exist at all.
      name: 'a bridge, a cross-chain message, or a cross-chain quote',
      pattern: /\b(?:bridgeTo|bridgeFrom|crossChainMessage|crossChainQuote|netAcrossChains)\b/i,
      positive: 'await bridgeTo(chain, amount);',
      negative: '// there is no bridge, and a quote never crosses a chain',
    },
  ];

  it.each(forbidden)('no source file contains $name', ({ pattern }) => {
    const offenders = sources.filter((file) => pattern.test(readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the scan above reads the real tree', () => {
    // `walk` returning `[]` — a moved directory, a renamed `src` — would leave
    // every rule above trivially satisfied and silent about it. Assert the
    // corpus is real and contains the file the next test reasons about.
    expect(sources.length).toBeGreaterThan(200);
    expect(sources).toContain(join(SRC, 'modules/settlement/jobs/reconciliation.job.ts'));
  });

  it('the forbidden patterns actually match something when it exists', () => {
    // A guard that matches nothing is satisfied by the absence of its subject.
    // This proves each regex fires on a minimal positive example, so an empty
    // `offenders` above means "not present" rather than "not detectable".
    for (const { name, pattern, positive } of forbidden) {
      expect([name, pattern.test(positive)]).toEqual([name, true]);
    }
  });

  it('the forbidden patterns are shapes, not words that appear in prose', () => {
    // The other half. A regex relaxed into a word-grep would fire on the
    // comments this codebase is full of, get exempted file by file, and end up
    // meaning nothing. Each negative is prose or legal per-chain code.
    for (const { name, pattern, negative } of forbidden) {
      expect([name, pattern.test(negative)]).toEqual([name, false]);
    }
  });

  it('the reconciler reads one chain at a time', () => {
    // Concretely: `ReconciliationJob` derives its work list from the enabled
    // chains and must iterate it, never fold it. A single run that reconciled a
    // sum would report a clean book while one chain was short and the other
    // over — the exact failure independence is meant to prevent.
    //
    // An earlier draft asserted `for (const x of …chains…)`. The job does not
    // spell it that way: it iterates ASSETS, and the per-chain step is the
    // `flatMap` over `enabledChains()` that builds that list — one asset
    // belongs to exactly one chain (`asset-registry.ts`), so an asset loop IS a
    // chain loop. Asserting that spelling would have failed on correct
    // code, which is how a guard gets deleted.
    const job = readFileSync(join(SRC, 'modules/settlement/jobs/reconciliation.job.ts'), 'utf8');

    expect(job).toMatch(/for\s*\(\s*const\s+\w+\s+of\s+this\.assets\(\)\s*\)/);
    expect(job).toMatch(/\.enabledChains\(\)\s*\.flatMap\(/);
    expect(job).not.toMatch(/chains[^\n;]{0,80}\.reduce\(/);
  });

  it('the reconciler visits every enabled chain and reconciles each on its own', async () => {
    // The behaviour behind the source assertion, because a docstring and a
    // regex both survive a rewrite that starts folding. Two chains in, two
    // separate `reconcile` calls out — never one call carrying both, and never
    // one chain's asset standing in for the other's.
    const reconcile = jest.fn().mockResolvedValue(undefined);
    const job = new ReconciliationJob(
      { reconcile } as unknown as ReconciliationService,
      {
        enabledChains: () => [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.SOLANA_MAINNET] as ChainId[],
      } as unknown as ChainAdapterRegistry,
    );

    await job.handleReconciliation();

    const reconciled = reconcile.mock.calls.map(([asset]: [AssetId]) => asset);
    expect(reconciled).toEqual([ASSET_IDS.USDC_SOLANA_DEVNET, ASSET_IDS.USDC_SOLANA_MAINNET]);
    // Each call is one asset — a string, never a list. A fold would have to
    // hand `reconcile` something plural to be a fold at all.
    for (const [asset] of reconcile.mock.calls) {
      expect(Array.isArray(asset)).toBe(false);
    }
  });

  it('disabling one chain leaves the other chain’s reconciliation untouched', async () => {
    // The operational half of independence: if turning off Solana perturbs
    // anything on the other chain, the independence is not real. Same job, one chain removed from
    // `ENABLED_CHAINS`; the surviving chain must be reconciled exactly as it
    // was — not skipped, not doubled, and not with a different asset.
    const both = jest.fn().mockResolvedValue(undefined);
    const one = jest.fn().mockResolvedValue(undefined);

    await new ReconciliationJob(
      { reconcile: both } as unknown as ReconciliationService,
      {
        enabledChains: () => [CHAIN_IDS.SOLANA_DEVNET, CHAIN_IDS.SOLANA_MAINNET] as ChainId[],
      } as unknown as ChainAdapterRegistry,
    ).handleReconciliation();

    await new ReconciliationJob(
      { reconcile: one } as unknown as ReconciliationService,
      {
        enabledChains: () => [CHAIN_IDS.SOLANA_MAINNET] as ChainId[],
      } as unknown as ChainAdapterRegistry,
    ).handleReconciliation();

    expect(one.mock.calls).toEqual([[ASSET_IDS.USDC_SOLANA_MAINNET]]);
    // And the surviving chain's call is byte-identical to the one it got when
    // the other chain was enabled — which is what "unaffected" has to mean.
    expect(one.mock.calls[0]).toEqual(
      both.mock.calls.find(([asset]: [AssetId]) => asset === ASSET_IDS.USDC_SOLANA_MAINNET),
    );
  });
});
