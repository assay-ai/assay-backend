import 'reflect-metadata';

import { AccountId, CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { DepositsController } from '@modules/ledger/controllers/deposits.controller';
import { DepositsService } from '@modules/ledger/services/deposits.service';
import { McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { SESSION_REQUEST_KEY } from '@shared/auth';
import { tenantCacheCaller, tenantCacheKey } from '@shared/cache/http-cache/tenant-cache-key';
import { TENANT_CACHE_KEY, TenantCacheOptions } from '@shared/decorators/tenant-cache.decorator';

function session(callerKind: McpCallerKind, agentId = 'agent-1'): McpSession {
  return {
    credentialId: 'credential-1',
    organizationId: 'organization-1',
    agentId,
    agentAccount: `${CHAIN_IDS.ROBINHOOD_TESTNET}:0x${'11'.repeat(20)}` as AccountId,
    chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
    label: null,
    callerKind,
    paymentsAllowed: true,
  };
}

describe('deposit status polling', () => {
  it.each([McpCallerKind.HUMAN, McpCallerKind.CONFIG, McpCallerKind.AGENT])(
    'passes the correct visibility filter for %s',
    async (kind) => {
      const getOne = jest.fn().mockResolvedValue({ id: 'deposit-1' });
      const controller = new DepositsController({ getOne } as unknown as DepositsService);

      await controller.getOne(session(kind), 'deposit-1');

      expect(getOne).toHaveBeenCalledWith(
        {
          organizationId: 'organization-1',
          agentId: kind === McpCallerKind.AGENT ? 'agent-1' : null,
        },
        'deposit-1',
      );
    },
  );

  it('cannot serve a cached status to another agent of the same organization', () => {
    const options = Reflect.getMetadata(
      TENANT_CACHE_KEY,
      DepositsController.prototype.getOne,
    ) as TenantCacheOptions;
    expect(options.vary).toBe('agent');

    const key = (caller: McpSession) => {
      const viewer = tenantCacheCaller({ [SESSION_REQUEST_KEY]: caller }, options.vary);
      if (!viewer) throw new Error('Expected a cacheable caller');
      return tenantCacheKey({
        path: '/api/v1/deposits/deposit-1',
        query: {},
        caller: viewer,
        scopes: options.epochs,
        epochs: ['1'],
      });
    };

    expect(key(session(McpCallerKind.AGENT))).not.toBe(
      key(session(McpCallerKind.AGENT, 'agent-2')),
    );
    expect(key(session(McpCallerKind.AGENT))).not.toBe(key(session(McpCallerKind.HUMAN)));
  });
});
