import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';

import { chainIdOf } from '@modules/chains/ports/caip.types';
import {
  PROVIDER_MINIMUM_STAKE_PARAMETERS,
  loadMinimumStakeParameters,
} from '@modules/provider/services/provider-stake.service';
import { SlashModule } from '@modules/slash/slash.module';
import { MinimumStakeParameters } from '@modules/tool/domain/routing/routing.types';
import { ContractMinimumStakeFloors } from '@modules/tool/services/contract-minimum-stake-floors.service';
import { ToolModule } from '@modules/tool/tool.module';
import { MoneyUtil } from '@shared/utils/money.util';

/**
 * The slash module's minimum stake is the routing floor (lot 1 C11): the
 * contract minimum once read (higher or lower), config until then, read from
 * `ToolModule`'s one `ContractMinimumStakeFloors`.
 */
interface FactoryProvider {
  provide: unknown;
  useFactory: (...args: unknown[]) => MinimumStakeParameters;
  inject: unknown[];
}

const providers = Reflect.getMetadata('providers', SlashModule) as unknown[];
const parametersProvider = providers.find(
  (p): p is FactoryProvider =>
    typeof p === 'object' &&
    p !== null &&
    (p as { provide?: unknown }).provide === PROVIDER_MINIMUM_STAKE_PARAMETERS,
) as FactoryProvider;

const config = new ConfigService({});
const configured = loadMinimumStakeParameters(config);
const chainId = chainIdOf(configured.floor.asset);
const times = (factor: number) =>
  MoneyUtil.of(
    String(BigInt(configured.floor.amount) * BigInt(factor)),
    configured.floor.asset,
    configured.floor.decimals,
  );

function floorsWith(floor: ReturnType<typeof times> | null): ContractMinimumStakeFloors {
  const map = new Map(floor ? [[chainId, { ...configured, floor }]] : []);
  return new ContractMinimumStakeFloors(map, null);
}

describe('SlashModule — minimum stake parameters', () => {
  it('reads the shared routing floors instance from ToolModule', () => {
    expect(parametersProvider).toBeDefined();
    expect(parametersProvider.inject).toEqual([ConfigService, ContractMinimumStakeFloors]);
    expect(Reflect.getMetadata('imports', SlashModule)).toContain(ToolModule);
    expect(Reflect.getMetadata('exports', ToolModule)).toContain(ContractMinimumStakeFloors);
    // Not re-provided here: a second instance could disagree with routing.
    expect(providers).not.toContain(ContractMinimumStakeFloors);
  });

  it('follows a stricter routing floor', () => {
    const floors = floorsWith(times(2));
    const parameters = parametersProvider.useFactory(config, floors);
    expect(parameters.floor).toEqual(times(2));
    expect(parameters.priceMultiple).toBe(configured.priceMultiple);
  });

  it('follows a later refresh of the routing floors', async () => {
    let read = false;
    const params = {
      current: jest.fn(() => ({
        chainId,
        source: read ? 'chain' : 'config',
        minimumStake: read ? times(3) : configured.floor,
      })),
      all: jest.fn(() => []),
      refresh: jest.fn(async () => {
        read = true;
      }),
      subscribe: jest.fn(() => () => undefined),
    };
    const floors = new ContractMinimumStakeFloors(
      new Map([[chainId, configured]]),
      params as never,
    );
    const parameters = parametersProvider.useFactory(config, floors);
    expect(parameters.floor).toEqual(configured.floor);
    await floors.refresh();
    expect(parameters.floor).toEqual(times(3));
  });

  it('follows a routing floor below the configured one (the chain wins)', () => {
    const lower = MoneyUtil.of('1', configured.floor.asset, configured.floor.decimals);
    const floors = new ContractMinimumStakeFloors(
      new Map([[chainId, { ...configured, floor: lower }]]),
      null,
    );
    expect(parametersProvider.useFactory(config, floors).floor).toEqual(lower);
  });
});
