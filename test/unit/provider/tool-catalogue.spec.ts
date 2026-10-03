import { ConfigService } from '@nestjs/config';

import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ProviderToolBindingsController } from '@modules/provider/controllers/provider-tool-bindings.controller';
import { ProviderToolBindingsService } from '@modules/provider/services/provider-tool-bindings.service';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, ToolTier } from '@modules/tool/ports/tool.types';

import { buildTool } from '../tool/helpers/routing-fixtures';
import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * `GET /providers/me/tool-bindings/catalogue` — the tools a provider may bind.
 *
 * The console's create-a-binding screen authors a mapping **onto a contract it
 * did not write**: the tool's `outputSchema` is what the response mapping has
 * to satisfy, and the tool's `inputSchema` is what the request mapping is fed.
 * Until this endpoint existed the console could not name a single tool — the
 * binding DTOs carry a `toolId` and nothing else — so the screen had a required
 * field with no picker behind it and an editor with no columns to draw.
 *
 * The two facts the cases below pin:
 *
 * - **the schemas survive byte-identical.** They are JSON Schema documents that
 *   the editor renders field by field and that `contract-check.ts` re-validates
 *   at Save. A payload that re-serialised, reordered or pruned them would make
 *   the console draw one contract and the server enforce another; and
 * - **the payload is platform-wide.** The catalogue is not a per-provider view,
 *   and the method that serves it takes no organization at all. The two-session
 *   case below cannot observe that — with no org in the signature the two calls
 *   are incapable of diverging — so it is a regression trap rather than a
 *   measurement: it goes red the day somebody scopes this read to a tenant.
 *
 * `settlementAsset` rides along for a smaller but harder reason: `create()`
 * runs `assertKnownAsset(body.assetId)`, and the console has no other way to
 * learn which asset this deployment settles in. Without it every create is a
 * guess that 400s.
 */

const TOOL_A = buildTool();
const TOOL_B = buildTool({
  id: 'summarise_text',
  name: 'Summarise text',
  description: 'Condenses a document into a short abstract.',
  inputSchema: {
    type: 'object',
    properties: { document: { type: 'string' }, maxWords: { type: 'integer' } },
    required: ['document'],
  },
  outputSchema: {
    type: 'object',
    properties: { summary: { type: 'string' }, words: { type: 'integer' } },
    required: ['summary'],
  },
  tier: ToolTier.GUARANTEED,
});

/** A `ConfigService` backed by a plain map, returning `undefined` for anything absent. */
function configOf(values: Record<string, string> = {}): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function build(tools: readonly Tool[], values: Record<string, string> = {}) {
  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(),
    listTools: jest.fn(async () => tools),
    findBindings: jest.fn(),
  };

  const bindings = {} as unknown as ToolBindingRepository;

  return {
    service: new ProviderToolBindingsService(bindings, catalogue, configOf(values)),
    catalogue,
  };
}

describe('ProviderToolBindingsService.getCatalogue — the tools a provider may bind', () => {
  it('returns every tool in the catalogue', async () => {
    const { service } = build([TOOL_A, TOOL_B]);

    const result = await service.getCatalogue();

    expect(result.tools.map((tool) => tool.id)).toEqual([TOOL_A.id, TOOL_B.id]);
    expect(result.tools.map((tool) => tool.name)).toEqual([TOOL_A.name, TOOL_B.name]);
    expect(result.tools.map((tool) => tool.tier)).toEqual([ToolTier.VERIFIED, ToolTier.GUARANTEED]);
  });

  it('carries the schemas and the description through byte-identical', async () => {
    const { service } = build([TOOL_A, TOOL_B]);

    const result = await service.getCatalogue();

    for (const [index, source] of [TOOL_A, TOOL_B].entries()) {
      const served = result.tools[index];

      expect(served.description).toBe(source.description);
      expect(served.inputSchema).toEqual(source.inputSchema);
      expect(served.outputSchema).toEqual(source.outputSchema);

      // `toEqual` would accept a reordered or re-typed document. The editor
      // draws its columns from these and the contract check re-validates
      // against them, so the bytes themselves are the contract.
      expect(JSON.stringify(served.inputSchema)).toBe(JSON.stringify(source.inputSchema));
      expect(JSON.stringify(served.outputSchema)).toBe(JSON.stringify(source.outputSchema));
    }
  });

  it('returns an empty list for an empty catalogue rather than throwing', async () => {
    const { service } = build([]);

    const result = await service.getCatalogue();

    // A provider with a brand-new deployment sees "no tools yet", not a 500.
    expect(result.tools).toEqual([]);
    // The asset is still resolved: it does not come from the catalogue.
    expect(result.settlementAsset.symbol).toBe('USDC');
  });

  it('reads the catalogue unpaged, once', async () => {
    const { service, catalogue } = build([TOOL_A, TOOL_B]);

    await service.getCatalogue();

    expect(catalogue.listTools).toHaveBeenCalledTimes(1);
    expect(catalogue.listTools).toHaveBeenCalledWith();
  });
});

describe('ProviderToolBindingsService.getCatalogue — the settlement asset', () => {
  it('reflects PLATFORM_STAKE_ASSET_ID when it is set', async () => {
    const { service } = build([TOOL_A], {
      PLATFORM_STAKE_ASSET_ID: ASSET_IDS.USDC_SOLANA_MAINNET,
    });

    const result = await service.getCatalogue();

    expect(result.settlementAsset).toEqual({
      assetId: ASSET_IDS.USDC_SOLANA_MAINNET,
      symbol: 'USDC',
      decimals: 6,
    });
  });

  it('falls back to devnet USDC when it is not', async () => {
    const { service } = build([TOOL_A]);

    const result = await service.getCatalogue();

    expect(result.settlementAsset).toEqual({
      assetId: ASSET_IDS.USDC_SOLANA_DEVNET,
      symbol: 'USDC',
      decimals: 6,
    });
  });

  it('treats an empty PLATFORM_STAKE_ASSET_ID as unset, not as an asset', async () => {
    // How the variable actually arrives in a `.env` copied from `.env.example`
    // and never filled in. `??` falls back on null/undefined only, so without a
    // guard the empty string reaches `getAssetMetadata` and this read — which
    // carries no input at all — answers `400 No asset metadata registered for`.
    for (const blank of ['', '   ']) {
      const { service } = build([TOOL_A], { PLATFORM_STAKE_ASSET_ID: blank });

      const result = await service.getCatalogue();

      expect(result.settlementAsset.assetId).toBe(ASSET_IDS.USDC_SOLANA_DEVNET);
    }
  });

  it('still throws for an asset id that is set and unknown', async () => {
    const { service } = build([TOOL_A], {
      PLATFORM_STAKE_ASSET_ID: 'solana:devnet/token:NotAMintWeHaveEverHeardOf',
    });

    // The other half of the guard above, and the reason it is a guard rather
    // than a `try`. An operator who points the platform at a mint the registry
    // does not know has made a mistake they need to hear about; silently
    // settling in devnet USDC instead would hide it until money moved.
    await expectErrorCodeAsync(() => service.getCatalogue(), ChainErrorCode.CHAIN_ASSET_UNKNOWN);
  });
});

describe('GET /providers/me/tool-bindings/catalogue — platform-wide, not per provider', () => {
  it('serves two different organizations the same payload', async () => {
    const { service } = build([TOOL_A, TOOL_B]);

    // Only `bindings` is reached — the catalogue route touches none of the
    // editor, tester, publisher or pauser, and passing them would hide that.
    const controller = new ProviderToolBindingsController(
      service,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );

    const first = await controller.catalogue(session('org-a'));
    const second = await controller.catalogue(session('org-b'));

    expect(first).toEqual(second);
    expect(first.tools).toHaveLength(2);
  });
});

function session(organizationId: string): McpSession {
  return { organizationId, credentialId: `cred-${organizationId}` } as McpSession;
}
