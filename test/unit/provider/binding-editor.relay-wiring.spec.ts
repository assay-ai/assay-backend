import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';

import { ToolBindingRepository } from '@database/postgres/repositories/tool-binding.repository';
import { ENABLED_CHAINS } from '@modules/chains/enabled-chains';
import { CHAIN_ENROLMENT_SOURCE } from '@modules/provider/ports/chain-enrolment.port';
import { PROVIDER_STAKE_SOURCE } from '@modules/provider/ports/provider-stake.port';
import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { BindingEditorService } from '@modules/provider/services/binding-editor.service';
import { PROVIDER_MINIMUM_STAKE_BY_CHAIN } from '@modules/provider/services/provider-stake.service';
import { TOOL_CATALOGUE } from '@modules/tool/ports/tool-catalogue.port';
import { NetworkModule } from '@shared/network/network.module';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * The relay config reaches the provider services through the real
 * `NetworkModule`, not through a hand-built constructor call.
 */
describe('BindingEditorService — relay config wiring', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  async function resolve(): Promise<BindingEditorService> {
    const module = await Test.createTestingModule({
      imports: [NetworkModule],
      providers: [
        BindingEditorService,
        { provide: ToolBindingRepository, useValue: {} },
        { provide: TOOL_CATALOGUE, useValue: { findTool: jest.fn() } },
        { provide: getDataSourceToken('postgres'), useValue: {} },
        { provide: CHAIN_ENROLMENT_SOURCE, useValue: {} },
        { provide: PROVIDER_STAKE_SOURCE, useValue: {} },
        { provide: ENABLED_CHAINS, useValue: [] },
        { provide: PROVIDER_MINIMUM_STAKE_BY_CHAIN, useValue: new Map() },
      ],
    }).compile();
    return module.get(BindingEditorService);
  }

  it('rejects a :3000 endpoint when EGRESS_RELAY_URL is set', async () => {
    process.env.EGRESS_RELAY_URL = 'https://egress.test';
    process.env.EGRESS_RELAY_TOKEN = 'a'.repeat(64);
    const service = await resolve();

    await expectErrorCodeAsync(
      () =>
        service.create('org', 'subject', {
          toolId: 'search_web',
          endpoint: 'https://p.test:3000/x',
        } as never),
      ProviderErrorCode.PROVIDER_ENDPOINT_PORT_NOT_SUPPORTED,
    );
  });
});
