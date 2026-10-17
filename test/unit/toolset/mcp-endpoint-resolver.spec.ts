import { McpErrorCode } from '@modules/mcp/errors/mcp.errors';
import { ProviderEntity } from '@database/postgres/entities/provider.entity';
import { ToolBindingEntity } from '@database/postgres/entities/tool-binding.entity';
import { AgentEntity } from '@database/postgres/entities/agent.entity';
import { QuoteIndexInvalidationSubscriber } from '@modules/tool/services/quote-index-invalidation.subscriber';
import { QuoteIndexService } from '@modules/tool/services/quote-index.service';
import { parseMcpUrl } from '@modules/toolset/domain/mcp-url';
import { AccessEpochService } from '@modules/toolset/services/access-epoch.service';
import { McpEndpointResolver } from '@modules/toolset/services/mcp-endpoint.resolver';

const ORG = '8192a3b4-2536-4d78-a9fa-0b1c2d3e4f50';
const TOOLSET = { id: 'ts-1', slug: 'research', name: 'Research', discovery: 'FULL' };

/** The base view is cached once per path; filters are applied after the lookup. */
describe('McpEndpointResolver', () => {
  function build() {
    const lookups = { slugs: 0 };
    const resolver = new McpEndpointResolver(
      {
        findOwnedBySlug: async (_org: string, slug: string) => {
          lookups.slugs += 1;
          return slug === TOOLSET.slug ? TOOLSET : null;
        },
      } as never,
      { findByToolsets: async () => [] } as never,
      { current: async () => '7' } as unknown as AccessEpochService,
      { mcpPublicUrl: 'https://mcp.example.com', webAppUrl: 'https://app.example.com' },
    );
    return { resolver, lookups };
  }

  it('shares one cached base view across every filter variant of a path', async () => {
    const { resolver, lookups } = build();
    for (const query of [
      '',
      '?tools=a_tool',
      '?tools=b_tool,c_tool',
      '?category=maps',
      '?free=1',
    ]) {
      await resolver.resolve(ORG, parseMcpUrl(`/my/research${query}`)!);
    }
    expect(lookups.slugs).toBe(1);
  });

  it('applies the filter after the lookup, dropping the toolset’s own discovery default', async () => {
    const { resolver } = build();
    const view = await resolver.resolve(
      ORG,
      parseMcpUrl('/my/research?discovery=full&tools=a_tool')!,
    );
    expect(view.canonicalUrl).toBe('https://mcp.example.com/my/research?tools=a_tool');
    expect(view.filter.tools).toEqual([{ name: 'a_tool', major: null }]);
    const other = await resolver.resolve(ORG, parseMcpUrl('/my/research?discovery=search')!);
    expect(other.canonicalUrl).toBe('https://mcp.example.com/my/research?discovery=search');
  });

  it('answers a missing slug with the same 404 every time, and never caches it', async () => {
    const { resolver, lookups } = build();
    for (let n = 0; n < 2; n += 1) {
      await expect(resolver.resolve(ORG, parseMcpUrl('/my/nope')!)).rejects.toMatchObject({
        errorCode: McpErrorCode.MCP_URL_NOT_FOUND,
      });
    }
    expect(lookups.slugs).toBe(2);
  });
});

describe('QuoteIndexInvalidationSubscriber', () => {
  it('drops the index on the writes a price depends on, and only those', () => {
    const index = { bumpEpoch: jest.fn(async () => undefined) } as unknown as QuoteIndexService;
    const subscriber = new QuoteIndexInvalidationSubscriber(index);
    subscriber.afterUpdate({ metadata: { target: ProviderEntity } } as never);
    subscriber.afterInsert({ metadata: { target: ToolBindingEntity } } as never);
    subscriber.afterUpdate({ metadata: { target: AgentEntity } } as never);
    expect(index.bumpEpoch).toHaveBeenCalledTimes(2);
  });
});
