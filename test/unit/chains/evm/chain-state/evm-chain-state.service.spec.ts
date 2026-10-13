import { Logger } from '@nestjs/common';

import { EvmChainStateService } from '@modules/chains/evm/chain-state/evm-chain-state.service';
import { ChainDoor } from '@modules/chains/ports/chain-state-gate.port';

const CHAIN = 'eip155:46630';
const CONFIG = '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43';
const BUYER = '0x1111111111111111111111111111111111111111';
const BLOCKED = '0x2222222222222222222222222222222222222222';

function build(options: {
  paused?: boolean;
  blocked?: string[];
  live?: { paused?: boolean; blocked?: string[]; fails?: boolean };
}) {
  const reads: string[] = [];
  const service = new EvmChainStateService(
    {
      findAllStates: async () => [{ chainId: CHAIN, paused: options.paused ?? false }],
      findBlocked: async () =>
        (options.blocked ?? []).map((address) => ({ chainId: CHAIN, address })),
    } as never,
    new Map([
      [
        CHAIN,
        {
          readContract: async ({
            functionName,
            args,
          }: {
            functionName: string;
            args: unknown[];
          }) => {
            reads.push(functionName);
            if (options.live?.fails) throw new Error('EVM RPC eth_call failed: HTTP 503');
            if (functionName === 'paused') return options.live?.paused ?? options.paused ?? false;
            return (options.live?.blocked ?? options.blocked ?? []).includes(
              String(args[0]).toLowerCase(),
            );
          },
        },
      ],
    ]) as never,
    new Map([[CHAIN, { config: CONFIG }]]) as never,
    { pollMs: 60_000 },
  );
  return { service, reads };
}

const buyer = (address = BUYER) => [{ role: 'BUYER', account: `${CHAIN}:${address}` }];

describe('EvmChainStateService — refuse early what the chain would refuse', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('passes without a single RPC when the cache says the chain is active', async () => {
    const { service, reads } = build({});
    await service.refresh();
    await expect(service.assertActive(ChainDoor.WITHDRAW, buyer())).resolves.toBeUndefined();
    expect(reads).toEqual([]);
  });

  it('refuses a withdrawal while paused on an upgraded Config, confirmed live', async () => {
    const { service, reads } = build({ paused: true });
    await service.refresh();
    await expect(service.assertActive(ChainDoor.WITHDRAW, buyer())).rejects.toMatchObject({
      errorCode: 'CHAIN_PROGRAM_PAUSED',
    });
    expect(reads).toEqual(['paused']);
  });

  it('a pause closes every door (the backend assumes the upgraded Config)', async () => {
    const { service } = build({ paused: true });
    await service.refresh();
    for (const door of Object.values(ChainDoor)) {
      await expect(service.assertActive(door, buyer())).rejects.toMatchObject({
        errorCode: 'CHAIN_PROGRAM_PAUSED',
      });
    }
  });

  it('refuses a blocked party by role, and ignores a non-EVM account', async () => {
    const { service } = build({ blocked: [BLOCKED] });
    await service.refresh();
    await expect(
      service.assertActive(ChainDoor.DELEGATE, [
        { role: 'PAYER', account: `${CHAIN}:${BUYER}` },
        { role: 'DELEGATE', account: `${CHAIN}:${BLOCKED}` },
        { role: 'PAYER', account: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:Abc' },
      ]),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_ADDRESS_BLOCKED', context: { role: 'DELEGATE' } });
  });

  it('never refuses on a stale cache: the live read says unblocked, so it passes', async () => {
    const { service } = build({ blocked: [BLOCKED], live: { blocked: [] } });
    await service.refresh();
    await expect(service.assertActive(ChainDoor.STAKE, buyer(BLOCKED))).resolves.toBeUndefined();
  });

  it('holds only on a live confirmation, and never when the chain cannot be read', async () => {
    const confirmed = build({ paused: true });
    await confirmed.service.refresh();
    await expect(confirmed.service.holdReason(ChainDoor.REDEEM, buyer())).resolves.toMatch(
      /paused/,
    );

    const unreadable = build({ paused: true, live: { fails: true } });
    await unreadable.service.refresh();
    // A hold can cost a voucher its redemption window; refusing a NEW action
    // costs nothing, so the two answer differently on an outage.
    await expect(unreadable.service.holdReason(ChainDoor.REDEEM, buyer())).resolves.toBeNull();
    await expect(unreadable.service.assertActive(ChainDoor.REDEEM, buyer())).rejects.toMatchObject({
      errorCode: 'CHAIN_PROGRAM_PAUSED',
    });
  });

  it('lists the cached blocked accounts confirmed live, for the redemption query (E-1)', async () => {
    const STALE = '0x3333333333333333333333333333333333333333';
    const { service } = build({ blocked: [BLOCKED, STALE], live: { blocked: [BLOCKED] } });
    await service.refresh();
    await expect(service.blockedAccounts(CHAIN)).resolves.toEqual([`${CHAIN}:${BLOCKED}`]);
    await expect(service.blockedAccounts('eip155:1')).resolves.toEqual([]);

    // An unreadable confirmation leaves the address out: a hold can cost a voucher.
    const unreadable = build({ blocked: [BLOCKED], live: { fails: true } });
    await unreadable.service.refresh();
    await expect(unreadable.service.blockedAccounts(CHAIN)).resolves.toEqual([]);
  });
});
