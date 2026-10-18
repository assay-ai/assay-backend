import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { loadToolCatalogue } from '@modules/tool/services/catalogue-seed';

/**
 * The catalogue seed, from a file **or** from an environment variable.
 *
 * ## Why the second source exists
 *
 * `TOOL_CATALOGUE_SEED_FILE` names a path, and a path needs a mounted file. The
 * document is 6 KB of JSON, so it can instead arrive as a value in an
 * environment variable, with no volume — which is what
 * `TOOL_CATALOGUE_SEED_JSON` is.
 *
 * ## Both set is a boot failure, deliberately
 *
 * Two sources for one answer is the failure this codebase keeps naming: a
 * mounted file and a stale environment variable would disagree silently, and
 * the catalogue is what the router substitutes providers against. Refusing at
 * boot costs one restart; picking a winner costs a deployment serving a
 * catalogue nobody believes they configured.
 */
describe('loadToolCatalogue', () => {
  // The local `.env` sets `TOOL_CATALOGUE_SEED_FILE` and jest's setupFiles
  // loads it, so the parameter defaults resolve to a real path unless this
  // suite clears them. Passing `undefined` explicitly is not enough — that is
  // exactly what triggers a default.
  const saved = {
    file: process.env.TOOL_CATALOGUE_SEED_FILE,
    json: process.env.TOOL_CATALOGUE_SEED_JSON,
  };

  beforeEach(() => {
    delete process.env.TOOL_CATALOGUE_SEED_FILE;
    delete process.env.TOOL_CATALOGUE_SEED_JSON;
  });

  afterAll(() => {
    if (saved.file === undefined) delete process.env.TOOL_CATALOGUE_SEED_FILE;
    else process.env.TOOL_CATALOGUE_SEED_FILE = saved.file;
    if (saved.json === undefined) delete process.env.TOOL_CATALOGUE_SEED_JSON;
    else process.env.TOOL_CATALOGUE_SEED_JSON = saved.json;
  });

  const tool = {
    id: '06399979-f8b8-4c9e-a9b1-bd2a5924d442',
    name: 'get_weather',
    description: 'Current temperature at a latitude/longitude.',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    verificationPolicyId: 'policy-default',
    tier: 'VERIFIED',
  };

  const document = { tools: [tool], bindings: [] };

  const fileWith = (contents: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'catalogue-seed-')), 'catalogue.json');
    writeFileSync(path, contents, 'utf8');
    return path;
  };

  it('is empty when neither source is set', () => {
    expect(loadToolCatalogue().tools).toHaveLength(0);
  });

  it('reads TOOL_CATALOGUE_SEED_JSON off the environment with no arguments', () => {
    // `ToolModule` calls `loadToolCatalogue()` with no arguments, so the
    // defaults are the production path and are what actually has to work.
    process.env.TOOL_CATALOGUE_SEED_JSON = JSON.stringify(document);

    expect(loadToolCatalogue().tools[0].name).toBe('get_weather');
  });

  it('treats a blank environment variable as unset, not as a broken document', () => {
    // A deployment config key with no value arrives as '', and a deployment
    // can ship exactly such a placeholder key. Empty must mean "no catalogue
    // configured", never "parse this".
    expect(loadToolCatalogue(undefined, '   ').tools).toHaveLength(0);
  });

  it('loads the document from TOOL_CATALOGUE_SEED_JSON', () => {
    const snapshot = loadToolCatalogue(undefined, JSON.stringify(document));

    expect(snapshot.tools).toHaveLength(1);
    expect(snapshot.tools[0].name).toBe('get_weather');
  });

  it('still loads the document from a file', () => {
    const snapshot = loadToolCatalogue(fileWith(JSON.stringify(document)), undefined);

    expect(snapshot.tools[0].id).toBe(tool.id);
  });

  it('refuses to boot when both sources are set', () => {
    expect(() =>
      loadToolCatalogue(fileWith(JSON.stringify(document)), JSON.stringify(document)),
    ).toThrow(/TOOL_CATALOGUE_SEED_FILE.*TOOL_CATALOGUE_SEED_JSON|both/i);
  });

  it('names the environment variable, not the file, when the inline document is malformed', () => {
    // The old message hard-coded `TOOL_CATALOGUE_SEED_FILE (undefined)`, which
    // sends the reader looking for a mount that was never the problem.
    expect(() => loadToolCatalogue(undefined, JSON.stringify({ tools: [] }))).toThrow(
      /TOOL_CATALOGUE_SEED_JSON/,
    );
  });

  it('names the environment variable when a binding references an unknown tool', () => {
    const orphan = {
      tools: [tool],
      bindings: [
        {
          id: 'b-1',
          toolId: 'not-in-this-document',
          providerId: 'p-1',
          endpoint: 'https://example.com',
          requestMapping: { method: 'GET', path: '/x' },
          responseMapping: {},
          pricingMode: 'PAID',
          priceAmount: '10000',
          assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
          slaFailureRate: 0.02,
          timeoutMs: 10_000,
          status: 'ACTIVE',
          version: 1,
        },
      ],
    };

    expect(() => loadToolCatalogue(undefined, JSON.stringify(orphan))).toThrow(
      /TOOL_CATALOGUE_SEED_JSON.*not-in-this-document/s,
    );
  });

  it('names the environment variable when a binding names no settlementChains', () => {
    // The settlementChains checks were written against the file source alone
    // and printed `TOOL_CATALOGUE_SEED_FILE (undefined)` for an inline
    // document — measured against a deployed scheduler, which crash-looped on exactly
    // this message while the catalogue came from TOOL_CATALOGUE_SEED_JSON.
    const unrouted = {
      tools: [tool],
      bindings: [
        {
          id: 'b-2',
          toolId: tool.id,
          providerId: 'p-1',
          endpoint: 'https://example.com',
          requestMapping: { method: 'GET', path: '/x' },
          responseMapping: {},
          pricingMode: 'PAID',
          priceAmount: '10000',
          assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
          slaFailureRate: 0.02,
          timeoutMs: 10_000,
          status: 'ACTIVE',
          version: 1,
        },
      ],
    };

    let message = '';
    try {
      loadToolCatalogue(undefined, JSON.stringify(unrouted));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^TOOL_CATALOGUE_SEED_JSON: binding b-2 names no settlementChains/);
    expect(message).not.toMatch(/undefined/);
  });
});

const DEVNET = CHAIN_IDS.SOLANA_DEVNET;

/**
 * `TOOL_CATALOGUE_SEED_FILE`'s boot-time refusals.
 *
 * The loader already refused a binding naming an unknown tool and a binding
 * priced in an unregistered asset. `settlement_chains` joins them for the same
 * reason both are there: the column is `NOT NULL` with a non-empty CHECK, so a
 * seed that omits it or names nonsense is a row Postgres refuses — and it would
 * refuse it inside whatever import writes the seed, a long way from the file
 * that is actually wrong. Boot loudly, next to the file being read.
 *
 * Each case below breaks **exactly one** thing about an otherwise-valid
 * document. A fixture that broke two would pass on whichever check ran first
 * and prove nothing about the other.
 */
describe('loadToolCatalogue — settlementChains', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'assay-catalogue-seed-'));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const TOOL = {
    id: 'search_web',
    name: 'search_web',
    description: 'Returns web results for a query.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    outputSchema: {
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
    },
    verificationPolicyId: 'policy-default',
    tier: 'VERIFIED',
  };

  const binding = (over: Record<string, unknown> = {}) => ({
    id: 'b1',
    toolId: TOOL.id,
    providerId: 'p1',
    endpoint: 'https://p1.example.com/api',
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.answer' },
    pricingMode: 'PAID',
    priceAmount: '50000',
    assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
    settlementChains: [DEVNET],
    freeQuotaPerAgent: null,
    freeDailyBudget: null,
    slaFailureRate: 0.02,
    timeoutMs: 5000,
    status: 'ACTIVE',
    version: 1,
    ...over,
  });

  /** One seed file per case, named for the case, so a failure says which. */
  const seed = (name: string, over: Record<string, unknown> = {}): string => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ tools: [TOOL], bindings: [binding(over)] }));
    return path;
  };

  it('loads a document whose binding names one settleable chain', () => {
    const snapshot = loadToolCatalogue(seed('valid'));
    expect(snapshot.bindings).toHaveLength(1);
    expect(snapshot.bindings[0].settlementChains).toEqual([DEVNET]);
  });

  it('refuses a binding that names no chains at all', () => {
    expect(() => loadToolCatalogue(seed('missing', { settlementChains: undefined }))).toThrow(
      /names no settlementChains/,
    );
  });

  it('refuses the empty array, which the row CHECK refuses too', () => {
    expect(() => loadToolCatalogue(seed('empty', { settlementChains: [] }))).toThrow(
      /names no settlementChains/,
    );
  });

  it('refuses an entry that is not a CAIP-2 chain id', () => {
    expect(() => loadToolCatalogue(seed('grammar', { settlementChains: ['mainnet'] }))).toThrow(
      /"mainnet" in settlementChains, which is not a CAIP-2 chain id/,
    );
  });

  /**
   * Well-formed and still refused: `eip155:1` parses, and nothing this
   * deployment registers settles there.
   *
   * This is the case the grammar check cannot reach, and it is the one that
   * matters in practice — a seed copied from a two-chain deployment onto a
   * Solana-only one is well-formed in every respect and produces a binding
   * offered where no price can be quoted.
   */
  it('refuses a well-formed chain that no registered asset lives on', () => {
    expect(() =>
      loadToolCatalogue(seed('unsettleable', { settlementChains: [DEVNET, 'eip155:1'] })),
    ).toThrow(/is offered on eip155:1, where no registered asset lives/);
  });
});
