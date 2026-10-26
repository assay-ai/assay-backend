import { Logger } from '@nestjs/common';
import { domainSeparator } from 'viem';

import {
  EVM_DOMAIN_MISMATCH_ALERT,
  EvmChainStateService,
} from '@modules/chains/evm/chain-state/evm-chain-state.service';
import { readDomainMismatches } from '@modules/chains/evm/eip712/domain-guard';
import { ChainDoor } from '@modules/chains/ports/chain-state-gate.port';
import { Alert, AlertSeverity } from '@shared/alerting';

const CHAIN = 'eip155:46630';
const CONFIG = '0xBF2DE8e24254Cf6f2313Ab4B5CeBE8066bBdb0e5';
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

describe('EvmChainStateService — the EIP-712 domain guard (reviews R1, R-3)', () => {
  const ESCROW = '0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f' as const;
  const STAKE = '0x7242F853db478A28Ae76Ace808212d4B68aa73e7' as const;
  const separator = (name: string, address: `0x${string}`) =>
    domainSeparator({ domain: { name, version: '2', chainId: 46630, verifyingContract: address } });

  function guarded() {
    let name = 'x402 Settlement';
    let fails = false;
    const alerts: Alert[] = [];
    const service = new EvmChainStateService(
      { findAllStates: async () => [], findBlocked: async () => [] } as never,
      new Map([
        [
          CHAIN,
          {
            readContract: async ({ address }: { address: `0x${string}` }) => {
              if (fails) throw new Error('EVM RPC eth_call failed: HTTP 503');
              return separator(name, address);
            },
          },
        ],
      ]) as never,
      new Map([[CHAIN, { config: CONFIG, escrow: ESCROW, stake: STAKE }]]) as never,
      { pollMs: 60_000 },
      { emit: async (alert: Alert) => void alerts.push(alert) },
    );
    return {
      service,
      alerts,
      upgrade: () => (name = 'Assay Settlement'),
      fail: (value: boolean) => (fails = value),
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('refuses vouchers and slash attestations on a mismatch, alerts once, and resumes on a match', async () => {
    const { service, alerts, upgrade } = guarded();
    await service.checkDomains();
    await service.checkDomains();

    await expect(service.assertActive(ChainDoor.REDEEM, buyer())).rejects.toMatchObject({
      errorCode: 'CHAIN_DOMAIN_MISMATCH',
    });
    expect(service.domainRefusal(CHAIN)).toMatchObject({ errorCode: 'CHAIN_DOMAIN_MISMATCH' });
    // A hold can cost a voucher already accepted: never held for this.
    await expect(service.holdReason(ChainDoor.REDEEM, buyer())).resolves.toBeNull();
    // The buyer's other doors are not this guard's.
    await expect(service.assertActive(ChainDoor.WITHDRAW, buyer())).resolves.toBeUndefined();
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: AlertSeverity.CRITICAL,
        name: EVM_DOMAIN_MISMATCH_ALERT,
        dedupeKey: CHAIN,
      }),
    ]);
    expect(Logger.prototype.error).toHaveBeenCalledTimes(1);

    upgrade();
    await service.checkDomains();
    await expect(service.assertActive(ChainDoor.REDEEM, buyer())).resolves.toBeUndefined();
    expect(service.domainRefusal(CHAIN)).toBeNull();
  });

  it('keeps the last answer when the separators cannot be read', async () => {
    const { service, fail, upgrade } = guarded();
    await service.checkDomains();
    fail(true);
    upgrade();
    await service.checkDomains();
    expect(service.domainRefusal(CHAIN)).not.toBeNull();
    fail(false);
    await service.checkDomains();
    expect(service.domainRefusal(CHAIN)).toBeNull();
  });
});

describe('readDomainMismatches', () => {
  it('flags the abandoned testnet proxies, which sign under "x402 Settlement"', async () => {
    // `DOMAIN_SEPARATOR()` as read from eip155:46630 on 2026-10-15.
    const live: Record<string, `0x${string}`> = {
      '0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f':
        '0x756591eb445d7b077d4f43aad09de3c4d087ef3af51f0292c34f5bddaba91c46',
      '0x7242F853db478A28Ae76Ace808212d4B68aa73e7':
        '0x39fa67988faa6ece2c823902be159c7cf175e083ddfe81176c17bb2709557ae1',
    };
    const client = { readContract: async ({ address }: { address: string }) => live[address] };
    const mismatches = await readDomainMismatches(client, CHAIN as never, {
      escrow: '0x1eDb0E45747cfEf778bDB4f4418319efc0DD814f',
      stake: '0x7242F853db478A28Ae76Ace808212d4B68aa73e7',
    });
    expect(mismatches.map((row) => row.contract)).toEqual(['AssayEscrow', 'AssayStake']);
  });
});

describe('EvmChainStateService.isBlockedLive — the whose-address read (review M1)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('reads the contract live, even when the cache knows nothing', async () => {
    const { service, reads } = build({ live: { blocked: [BLOCKED.toLowerCase()] } });
    await service.refresh();

    await expect(service.isBlockedLive(`${CHAIN}:${BLOCKED}`)).resolves.toBe(true);
    await expect(service.isBlockedLive(`${CHAIN}:${BUYER}`)).resolves.toBe(false);
    expect(reads).toEqual(['blocked', 'blocked']);
  });

  it('answers null when the read fails or the account is not on an EVM chain', async () => {
    const { service } = build({ live: { fails: true } });
    await expect(service.isBlockedLive(`${CHAIN}:${BLOCKED}`)).resolves.toBeNull();
    await expect(
      service.isBlockedLive(
        'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo',
      ),
    ).resolves.toBeNull();
  });
});

describe('EvmChainStateService — follows on-chain config changes', () => {
  it('re-reads the on-chain params when the indexer stamps a new params change, not before', async () => {
    let stamp: Date | null = null;
    const params = { refresh: jest.fn(async () => undefined) };
    const service = new EvmChainStateService(
      {
        findAllStates: async () => [{ chainId: CHAIN, paused: false, paramsChangedAt: stamp }],
        findBlocked: async () => [],
      } as never,
      new Map() as never,
      new Map([[CHAIN, { config: CONFIG }]]) as never,
      { pollMs: 60_000 },
      null,
      params as never,
    );
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await service.refresh();
    await service.refresh();
    expect(params.refresh).not.toHaveBeenCalled();

    stamp = new Date('2026-10-25T00:00:00Z');
    await service.refresh();
    await service.refresh();
    expect(params.refresh).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
  });
});
