import { encodeFunctionResult } from 'viem';

import {
  X402_STAKE_ABI,
  X402_STAKE_LEGACY_SLASH_RECORD_ABI,
} from '@modules/chains/evm/abi/x402.abi';
import { readConfigTerms } from '@modules/chains/evm/evm-config-terms';
import { decodeSlashRecord, readSlashRecord } from '@modules/chains/evm/evm-slash-record';
import { cancelReasonFromEvm, slashStatusFromEvm } from '@modules/chains/evm/evm-slash-status';

const STAKE = '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c' as const;
const CONFIG = '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43' as const;
const ID = `0x${'ab'.repeat(32)}` as const;

const LEGACY = {
  provider: '0x1111111111111111111111111111111111111111',
  status: 1,
  penalty: 500_000n,
  beneficiary: '0x2222222222222222222222222222222222222222',
  proposedAt: 1_791_700_000n,
  __gap: 0,
  verifier: '0x3333333333333333333333333333333333333333',
  executableAt: 1_791_959_200n,
  __gap2: 0,
  reserved: 400_000n,
  capAllowance: 1_000_000n,
  applied: 0n,
  executedAt: 0n,
  policy: `0x${'cd'.repeat(32)}`,
} as const;

const legacyBytes = () =>
  encodeFunctionResult({
    abi: X402_STAKE_LEGACY_SLASH_RECORD_ABI,
    functionName: 'slashRecordOf',
    result: LEGACY as never,
  });
const currentBytes = (disputedAt: bigint, status = 4) =>
  encodeFunctionResult({
    abi: X402_STAKE_ABI,
    functionName: 'slashRecordOf',
    result: { ...LEGACY, status, disputedAt } as never,
  });

/**
 * The dispute upgrade appended `disputedAt` to `SlashRecord`: fourteen ABI
 * words became fifteen. The backend is deployed BEFORE the upgrade lands, so
 * every read must decode both, and pick up the new field the moment it exists.
 */
describe('slashRecordOf across the dispute upgrade', () => {
  it('decodes the pre-upgrade record, with disputedAt 0', () => {
    expect(decodeSlashRecord(legacyBytes())).toMatchObject({
      status: 1,
      penalty: 500_000n,
      executableAt: 1_791_959_200n,
      disputedAt: 0n,
    });
  });

  it('decodes the upgraded record, disputedAt included', () => {
    const record = decodeSlashRecord(currentBytes(1_791_800_000n));
    expect(record.disputedAt).toBe(1_791_800_000n);
    expect(slashStatusFromEvm(record.status)).toBe('DISPUTED');
  });

  it('reads an old Stake through readContract by falling back on the decode failure', async () => {
    const calls: unknown[] = [];
    // A real viem decode of the old bytes against the new shape — the failure
    // the fallback exists for, not a hand-made error.
    const client = {
      readContract: async (args: { abi: unknown }) => {
        calls.push(args.abi);
        const { decodeFunctionResult } = await import('viem');
        return decodeFunctionResult({
          abi: args.abi as typeof X402_STAKE_ABI,
          functionName: 'slashRecordOf',
          data: legacyBytes(),
        });
      },
    };
    const record = await readSlashRecord(client, STAKE, ID);
    expect(record.disputedAt).toBe(0n);
    expect(record.penalty).toBe(500_000n);
    expect(calls).toEqual([X402_STAKE_ABI, X402_STAKE_LEGACY_SLASH_RECORD_ABI]);
  });

  it('does not mistake an outage for an old Stake', async () => {
    const client = {
      readContract: async () => {
        throw new Error('EVM RPC eth_call failed: HTTP 503');
      },
    };
    await expect(readSlashRecord(client, STAKE, ID)).rejects.toThrow(/HTTP 503/);
  });

  it('names every cancel reason, the dispute timeout included, and refuses others', () => {
    expect([0, 1, 2, 3].map(cancelReasonFromEvm)).toEqual([
      'WITHDRAWN',
      'EXPIRED',
      'VERIFIER_UNAVAILABLE',
      'DISPUTE_UNRESOLVED',
    ]);
    expect(() => cancelReasonFromEvm(4)).toThrow(/CancelReason/);
  });
});

describe('readConfigTerms', () => {
  const revert = () => {
    const error = new Error('reverted') as Error & { cause?: unknown };
    error.name = 'ContractFunctionExecutionError';
    error.cause = Object.assign(new Error('x'), { name: 'ContractFunctionRevertedError' });
    return error;
  };

  it('reads an old Config (no slashDelaySeconds) as not upgraded, with its own 72 h delay', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused') return true;
        throw revert();
      },
    };
    await expect(readConfigTerms(client, CONFIG)).resolves.toEqual({
      upgraded: false,
      paused: true,
      arbiter: null,
      slashDelaySeconds: 259_200,
    });
  });

  it('reads the live delay and the arbiter from an upgraded Config', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        ({
          paused: false,
          slashDelaySeconds: 600n,
          arbiter: '0x4444444444444444444444444444444444444444',
        })[functionName],
    };
    await expect(readConfigTerms(client, CONFIG)).resolves.toEqual({
      upgraded: true,
      paused: false,
      arbiter: '0x4444444444444444444444444444444444444444',
      slashDelaySeconds: 600,
    });
  });

  it('reads arbiter 0x0 as none', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) =>
        ({
          paused: false,
          slashDelaySeconds: 259_200n,
          arbiter: '0x0000000000000000000000000000000000000000',
        })[functionName],
    };
    expect((await readConfigTerms(client, CONFIG)).arbiter).toBeNull();
  });

  it('rethrows an outage rather than reading the Config as old', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'paused') return false;
        throw new Error('EVM RPC eth_call failed: HTTP 503');
      },
    };
    await expect(readConfigTerms(client, CONFIG)).rejects.toThrow(/HTTP 503/);
  });
});
