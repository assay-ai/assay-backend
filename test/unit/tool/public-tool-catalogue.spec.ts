import { ToolsController } from '@modules/tool/controllers/tools.controller';
import { ToolCataloguePort } from '@modules/tool/ports/tool-catalogue.port';
import { Tool, ToolTier } from '@modules/tool/ports/tool.types';
import { PublicToolCatalogueService } from '@modules/tool/services/public-tool-catalogue.service';

import { buildTool } from './helpers/routing-fixtures';

/**
 * `GET /tools` — the tool contracts, named.
 *
 * Every buyer screen that names a tool had only `payment_intents.tool_id` to
 * print, which is a uuid, and `/tool-calls` joins nothing that would fix it.
 * The Explore tabs rendered `06399979-f8b8-4c9e-a9b1-bd2a5924d442` in the
 * column headed "Tool". This endpoint is the join.
 *
 * Three facts the cases below pin:
 *
 * - **the names come from the router's own catalogue.** Not a label table, not
 *   a translation file: the same `TOOL_CATALOGUE` port the router routes on.
 *   Two sources for one name is how a receipt ends up naming a tool the
 *   catalogue does not have;
 * - **the payload withholds the contract and the policy.** `inputSchema`,
 *   `outputSchema` and `verificationPolicyId` are not a buyer's business — the
 *   first two are what a *provider* authors a mapping against, and the third
 *   invites a mapping written to satisfy the judge rather than the contract.
 *   The case is written as an exact key set so that a field added to `Tool`
 *   cannot arrive here by accident; and
 * - **the answer does not depend on who is asking.** A tool contract is
 *   platform-authored and identical for every caller. The service takes no
 *   organization at all, so the two-caller case cannot observe a divergence —
 *   it is a regression trap rather than a measurement, and it goes red the day
 *   somebody scopes this read to a tenant.
 */

const WEATHER = buildTool({
  id: '06399979-f8b8-4c9e-a9b1-bd2a5924d442',
  name: 'get_weather',
  description: 'Current temperature at a latitude/longitude.',
  tier: ToolTier.VERIFIED,
});

const RATE = buildTool({
  id: 'a4b9882a-9bc1-4d64-807a-27c0b93daf0a',
  name: 'get_usd_eur_rate',
  description: 'The latest USD to EUR reference exchange rate.',
  tier: ToolTier.GUARANTEED,
});

function build(tools: readonly Tool[]) {
  const catalogue: ToolCataloguePort = {
    findTool: jest.fn(),
    listTools: jest.fn(async () => tools),
    findBindings: jest.fn(),
  };

  const service = new PublicToolCatalogueService(catalogue);

  return { catalogue, service, controller: new ToolsController(service) };
}

describe('GET /tools', () => {
  it('names every tool in the catalogue', async () => {
    const { controller } = build([WEATHER, RATE]);

    await expect(controller.list()).resolves.toEqual({
      tools: [
        {
          id: '06399979-f8b8-4c9e-a9b1-bd2a5924d442',
          name: 'get_weather',
          description: 'Current temperature at a latitude/longitude.',
          tier: ToolTier.VERIFIED,
        },
        {
          id: 'a4b9882a-9bc1-4d64-807a-27c0b93daf0a',
          name: 'get_usd_eur_rate',
          description: 'The latest USD to EUR reference exchange rate.',
          tier: ToolTier.GUARANTEED,
        },
      ],
    });
  });

  /**
   * The contract and the policy stay behind. Asserted as an exact key set, not
   * as `not.toHaveProperty` per field: the point is that a field added to
   * `Tool` tomorrow does not reach a buyer because somebody spread the object.
   */
  it('publishes four fields and no others', async () => {
    const { controller } = build([WEATHER]);

    const { tools } = await controller.list();

    expect(Object.keys(tools[0]).sort()).toEqual(['description', 'id', 'name', 'tier']);
  });

  it('serves an empty catalogue as an empty list, not as an error', async () => {
    const { controller } = build([]);

    await expect(controller.list()).resolves.toEqual({ tools: [] });
  });

  /**
   * A regression trap. With no organization in the signature these two calls
   * are incapable of diverging — which is the property being protected.
   */
  it('answers every caller identically', async () => {
    const { controller } = build([WEATHER, RATE]);

    const [first, second] = await Promise.all([controller.list(), controller.list()]);

    expect(first).toEqual(second);
  });

  it('reads the router’s own catalogue port', async () => {
    const { catalogue, controller } = build([WEATHER]);

    await controller.list();

    expect(catalogue.listTools).toHaveBeenCalledTimes(1);
    expect(catalogue.findTool).not.toHaveBeenCalled();
  });
});
