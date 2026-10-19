import { encodeFunctionResult } from 'viem';
import { baseSepolia } from 'viem/chains';

import { ASSAY_STAKE_ABI } from '@modules/chains/evm/abi/assay.abi';
import { checkConfigUpgraded, readConfigTerms } from '@modules/chains/evm/evm-config-terms';
import { decodeSlashRecord, readSlashRecord } from '@modules/chains/evm/evm-slash-record';
import { cancelReasonFromEvm, slashStatusFromEvm } from '@modules/chains/evm/evm-slash-status';
import { createSanctionedEvmClient } from '@modules/chains/evm/sanctioned-evm-rpc';

const STAKE = '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c' as const;
const CONFIG = '0xCf6592A3a053d9714D16d176A86fA039Fe7B6a43' as const;
const ID = `0x${'ab'.repeat(32)}` as const;

const RECORD = {
  provider: '0x1111111111111111111111111111111111111111',
  status: 4,
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
  disputedAt: 1_791_800_000n,
} as const;

const recordBytes = () =>
  encodeFunctionResult({
    abi: ASSAY_STAKE_ABI,
    functionName: 'slashRecordOf',
    result: RECORD as never,
  });

describe('slashRecordOf (the upgraded Stake only)', () => {
  it('decodes the record, disputedAt included', () => {
    const record = decodeSlashRecord(recordBytes());
    expect(record.disputedAt).toBe(1_791_800_000n);
    expect(record.penalty).toBe(500_000n);
    expect(slashStatusFromEvm(record.status)).toBe('DISPUTED');
  });

  it('refuses bytes too short for the upgraded record: there is no legacy fallback', () => {
    const short = `0x${recordBytes().slice(2, 2 + 14 * 64)}` as `0x${string}`;
    expect(() => decodeSlashRecord(short)).toThrow();
  });

  it('rethrows any read failure as it came', async () => {
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

/**
 * A REAL `createSanctionedEvmClient` against a stub HTTP node (audit T-2: the
 * old tests simulated an outage with a plain `Error`, which is not what the
 * transport produces). `paused()` and `arbiter()` answer; `slashDelaySeconds()`
 * gets the node reply under test.
 */
const FALSE_WORD = `0x${'0'.repeat(64)}`;
const ARBITER_WORD = `0x${'0'.repeat(24)}${'44'.repeat(20)}`;
const DELAY_WORD = `0x${(600).toString(16).padStart(64, '0')}`;

function clientAnswering(delayReply: object) {
  const http = {
    request: async ({ body }: { body: string }) => {
      const { id, params } = JSON.parse(body) as { id: number; params: [{ data: string }] };
      const data = params[0].data;
      const reply = (payload: object) => ({
        status: 200,
        body: JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
      });
      if (data.startsWith('0x5c975abb')) return reply({ result: FALSE_WORD }); // paused()
      if (data.startsWith('0xfe25e00a')) return reply({ result: ARBITER_WORD }); // arbiter()
      return reply(delayReply);
    },
  };
  return createSanctionedEvmClient('http://node', http as never, baseSepolia);
}

describe('readConfigTerms, through the real transport', () => {
  it('reads the live delay and the arbiter', async () => {
    await expect(
      readConfigTerms(clientAnswering({ result: DELAY_WORD }) as never, CONFIG),
    ).resolves.toEqual({
      paused: false,
      arbiter: '0x4444444444444444444444444444444444444444',
      slashDelaySeconds: 600,
    });
  });

  // AUDIT E-3 (resolved by removal): none of these may be read as an "old
  // Config" with an assumed 72 h delay. Each is an error the caller retries.
  const outages: [string, object][] = [
    ['code -32603 internal error', { error: { code: -32603, message: 'internal error' } }],
    ['code -32000 header not found', { error: { code: -32000, message: 'header not found' } }],
    ['code -32005 rate limited', { error: { code: -32005, message: 'limit exceeded' } }],
    ['code 3 execution reverted, no data', { error: { code: 3, message: 'execution reverted' } }],
    ['result 0x (lagging node)', { result: '0x' }],
  ];
  for (const [label, reply] of outages) {
    it(`throws on ${label}, never assuming a delay`, async () => {
      await expect(readConfigTerms(clientAnswering(reply) as never, CONFIG)).rejects.toThrow();
    });
  }

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
});

describe('checkConfigUpgraded (the one boot-time check)', () => {
  it('logs one clear error when the Config does not answer arbiter()', async () => {
    const errors: string[] = [];
    const client = clientAnswering({ result: DELAY_WORD });
    const broken = {
      readContract: async () => {
        throw new Error('execution reverted');
      },
    };
    await expect(
      checkConfigUpgraded(client as never, CONFIG, 'eip155:84532', {
        error: (m) => errors.push(m),
      }),
    ).resolves.toBe(true);
    await expect(
      checkConfigUpgraded(broken, CONFIG, 'eip155:84532', { error: (m) => errors.push(m) }),
    ).resolves.toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/contracts not upgraded/);
  });
});
