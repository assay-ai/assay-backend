import { Logger } from '@nestjs/common';
import { encodeFunctionResult } from 'viem';

import { ASSAY_STAKE_ABI } from '@modules/chains/evm/abi/assay.abi';
import {
  EVM_VERIFIER_EXPIRY_ALERTS,
  EvmVerifierExpiryMonitor,
  VERIFIER_EXPIRY_PAGE_SIZE,
} from '@modules/chains/evm/evm-verifier-expiry.monitor';
import { Alert, AlertSeverity } from '@shared/alerting';

const CHAIN = 'eip155:46630' as never;
const STAKE = '0x7242F853db478A28Ae76Ace808212d4B68aa73e7';
const CONFIG = '0xBF2DE8e24254Cf6f2313Ab4B5CeBE8066bBdb0e5';
const SOON = '0x1111111111111111111111111111111111111111';
const LATER = '0x2222222222222222222222222222222222222222';
const NOW = new Date('2026-10-14T00:00:00Z');
const DAY = 86_400;

function record(verifier: string) {
  return {
    provider: '0x3333333333333333333333333333333333333333',
    status: 1,
    penalty: 1n,
    beneficiary: '0x4444444444444444444444444444444444444444',
    proposedAt: 1n,
    __gap: 0,
    verifier,
    executableAt: 2n,
    __gap2: 0,
    reserved: 1n,
    capAllowance: 1n,
    applied: 0n,
    executedAt: 0n,
    policy: `0x${'00'.repeat(32)}`,
    disputedAt: 0n,
  };
}

function build(records: { requestId: string; verifier: string }[]) {
  const alerts: Alert[] = [];
  const expiries: Record<string, bigint> = {
    [SOON]: BigInt(Math.floor(NOW.getTime() / 1000) + 30 * DAY),
    [LATER]: BigInt(Math.floor(NOW.getTime() / 1000) + 90 * DAY),
  };
  const client = {
    readContract: async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
      if (functionName === 'slashRecordOf') {
        const found = records.find((row) => `0x${row.requestId}` === args[0]);
        return (await import('viem')).decodeFunctionResult({
          abi: ASSAY_STAKE_ABI,
          functionName: 'slashRecordOf',
          data: encodeFunctionResult({
            abi: ASSAY_STAKE_ABI,
            functionName: 'slashRecordOf',
            result: record(found!.verifier) as never,
          }),
        });
      }
      if (functionName === 'verifierKey') {
        return { expiresAt: expiries[String(args[0])], revoked: false };
      }
      throw new Error(functionName);
    },
  };
  const monitor = new EvmVerifierExpiryMonitor(
    new Map([[CHAIN, client]]) as never,
    new Map([[CHAIN, { stake: STAKE, config: CONFIG }]]) as never,
    [CHAIN],
    {
      findOpenChainRecords: async (limit: number, offset = 0) =>
        records.slice(offset, offset + limit).map((row) => ({
          requestId: row.requestId,
          assetId: `${CHAIN}/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3`,
        })),
    } as never,
    { emit: async (alert: Alert) => void alerts.push(alert) },
  );
  return { monitor, alerts };
}

describe('EvmVerifierExpiryMonitor (follow-up B5)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('warns for a key with open records that expires within 45 days, and not for a later one', async () => {
    const { monitor, alerts } = build([
      { requestId: 'a'.repeat(64), verifier: SOON },
      { requestId: 'b'.repeat(64), verifier: SOON },
      { requestId: 'c'.repeat(64), verifier: LATER },
    ]);
    await expect(monitor.check(NOW)).resolves.toEqual([{ chainId: CHAIN, verifier: SOON }]);
    expect(alerts).toEqual([
      expect.objectContaining({
        severity: AlertSeverity.WARN,
        name: EVM_VERIFIER_EXPIRY_ALERTS.EXPIRING,
        details: expect.objectContaining({ verifier: SOON, openRecords: 2 }),
      }),
    ]);
  });

  it('pages past the first 500 open records (review S-7)', async () => {
    const rows = Array.from({ length: VERIFIER_EXPIRY_PAGE_SIZE }, (_, index) => ({
      requestId: index.toString(16).padStart(64, '0'),
      verifier: LATER,
    }));
    // The 501st record is the only one signed by the expiring key.
    rows.push({ requestId: 'f'.repeat(64), verifier: SOON });
    const { monitor } = build(rows);
    await expect(monitor.check(NOW)).resolves.toEqual([{ chainId: CHAIN, verifier: SOON }]);
  });

  it('says nothing when no record is open', async () => {
    const { monitor, alerts } = build([]);
    await expect(monitor.check(NOW)).resolves.toEqual([]);
    expect(alerts).toEqual([]);
  });
});
