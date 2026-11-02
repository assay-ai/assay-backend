import { readDeployment } from '@modules/chains/evm/evm.module';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

import { deployment } from './evm-fixtures';

/**
 * Final review 2026-11-01 ops F1: the deployment record may list the escrow
 * implementations it still accepts besides the current one, so the backend
 * can be deployed with old + new BEFORE `upgradeToAndCall`.
 */
const CHAIN = CHAIN_IDS.BASE_SEPOLIA;
const BASE = { ...deployment(CHAIN as never) } as Record<string, unknown>;
delete BASE.chainId;

describe('readDeployment: previousEscrowImplementations', () => {
  it('is optional (absent → no previous implementations)', () => {
    const record = readDeployment(BASE, CHAIN as never);
    expect(record.previousEscrowImplementations ?? []).toEqual([]);
  });

  it('keeps a list of addresses', () => {
    const previous = ['0x1111111111111111111111111111111111111111'];
    const record = readDeployment(
      { ...BASE, previousEscrowImplementations: previous },
      CHAIN as never,
    );
    expect(record.previousEscrowImplementations).toEqual(previous);
  });

  it.each([
    ['not an array', '0x1111111111111111111111111111111111111111'],
    ['a non-address entry', ['0x1234']],
    ['a non-string entry', [42]],
  ])('refuses %s', (_label, value) => {
    expect(() =>
      readDeployment({ ...BASE, previousEscrowImplementations: value }, CHAIN as never),
    ).toThrow();
  });
});

describe('readDeployment: channelDoorFromBlock (ops F13)', () => {
  it('is optional', () => {
    expect(readDeployment(BASE, CHAIN as never).channelDoorFromBlock).toBeUndefined();
  });

  it.each([
    [12_345, 12_345n],
    ['12345', 12_345n],
  ])('reads %p as a block number', (value, expected) => {
    expect(
      readDeployment({ ...BASE, channelDoorFromBlock: value }, CHAIN as never).channelDoorFromBlock,
    ).toBe(expected);
  });

  it.each([[-1], [1.5], ['0x10'], ['abc'], [null]])('refuses %p', (value) => {
    expect(() =>
      readDeployment({ ...BASE, channelDoorFromBlock: value }, CHAIN as never),
    ).toThrow();
  });
});
