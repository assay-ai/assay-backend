import { decodeFunctionData, getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { X402_CONFIG_ARBITER_ABI, X402_STAKE_SLASH_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EvmSlashExecutor } from '@modules/chains/evm/evm-slash-executor.service';
import { SlashProposalRequest } from '@modules/slash/ports/slash-executor.port';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

import {
  CHAIN,
  DEPLOYMENT,
  FakeStakeChain,
  MULTICALL,
  OWNER,
  RELAYER,
  STAKE,
  TREASURY,
} from './helpers/fake-stake-chain';

const VERIFIER_SECRET = new Uint8Array(32).fill(9);
const VERIFIER = privateKeyToAccount(toHex(VERIFIER_SECRET)).address;
const PROVIDER = '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';
const AGENTS = [
  '0x976ea74026e726554db657fa54763abd0c3a0aa9',
  '0x64fecbe18e8998cb2990bce631a042f8e2be1659',
  '0xd30814fd3916fc7fc6ea87d4c429f7b0b7cc4d1d',
  '0x1111111111111111111111111111111111111112',
  '0x1111111111111111111111111111111111111113',
];

function requestId(n: number): string {
  return n.toString(16).padStart(64, 'a');
}

function proposal(
  n: number,
  penalty = '100000',
  beneficiary = AGENTS[n % AGENTS.length],
): SlashProposalRequest {
  return {
    chainId: CHAIN,
    requestId: requestId(n),
    provider: PROVIDER,
    beneficiary,
    penaltyMinor: penalty,
    policy: 'tool-uuid',
    responseClass: 'dataFail',
  };
}

function build(options: { multicall?: boolean; batchSize?: number } = {}) {
  const chain = new FakeStakeChain(VERIFIER);
  chain.bond(PROVIDER, 180_000_000n, 20_000_000n, 1_000_000n);
  const backend = new Secp256k1EnvSigner(
    [{ keyId: 'v1', chainId: CHAIN, secretKey: Uint8Array.from(VERIFIER_SECRET) }],
    'test',
  );
  const signatures: { chainId: string; requestId: string | null; purpose: string }[] = [];
  const signer = {
    async sign(request: {
      chainId: string;
      purpose: string;
      requestId: string | null;
      payload: Uint8Array;
    }) {
      signatures.push(request);
      const signature = await backend.sign('v1', request.payload);
      await chain.trustSignature(toHex(request.payload), toHex(signature));
      return { signature, publicKey: (await backend.getKey('v1')).publicKey };
    },
    async publicKey() {
      return (await backend.getKey('v1')).publicKey;
    },
  };
  const executor = new EvmSlashExecutor(
    new Map([[CHAIN, chain.client]]),
    new Map([[CHAIN, DEPLOYMENT]]),
    chain.relayer,
    { get: () => signer },
    'VerifierSigningService',
    {
      now: () => Number(chain.now) * 1000,
      batchSize: options.batchSize ?? 20,
      multicall: options.multicall === false ? new Map() : new Map([[CHAIN, MULTICALL]]),
      executeDeferLimitMs: 3 * 24 * 3_600_000,
      receiptRetryDelayMs: 0,
    },
  );
  return { chain, executor, signatures };
}

const ARBITER = '0x5555555555555555555555555555555555555555';

async function upgraded() {
  const built = build();
  built.chain.arbiter = ARBITER;
  await built.executor.propose(proposal(1));
  await built.executor.propose(proposal(2));
  built.chain.sent.length = 0;
  return built;
}

describe('EvmSlashExecutor — the dispute upgrade (D-19)', () => {
  it('reads an undisputed record with disputedAt null', async () => {
    const { executor } = build();
    await executor.propose(proposal(1));
    await expect(executor.readRecord(requestId(1), PROVIDER, CHAIN)).resolves.toMatchObject({
      status: 'PENDING',
      disputedAt: null,
    });
  });

  it('reads the live slash delay, and throws (never assumes 72 h) when it cannot', async () => {
    const { chain, executor } = build();
    chain.slashDelay = 600n;
    await expect(executor.slashDelaySeconds(CHAIN)).resolves.toBe(600);
    chain.client.readContract = async () => {
      throw new Error('EVM RPC eth_call failed: HTTP 503');
    };
    await expect(executor.slashDelaySeconds(CHAIN)).rejects.toThrow(/HTTP 503/);
  });

  it('builds the cancel for the ARBITER only, and refuses without one', async () => {
    const { chain, executor } = await upgraded();
    const arbiterIntent = await executor.buildCancel({
      chainId: CHAIN,
      requestId: requestId(1),
      provider: PROVIDER,
    });
    expect(arbiterIntent).toMatchObject({ admin: ARBITER, signerRole: 'ARBITER' });

    chain.arbiter = '0x0000000000000000000000000000000000000000';
    await expect(
      executor.buildCancel({ chainId: CHAIN, requestId: requestId(1), provider: PROVIDER }),
    ).rejects.toMatchObject({ errorCode: 'CHAIN_ARBITER_NOT_SET' });
    expect(chain.sent).toHaveLength(0);
  });

  describe('disputeSlashBatch', () => {
    it('builds one call for the provider when every id passes', async () => {
      const { chain, executor } = await upgraded();
      const built = await executor.buildDisputeBatch({
        chainId: CHAIN,
        provider: PROVIDER,
        requestIds: [requestId(1), `0x${requestId(2)}`],
      });
      expect(built.refusals).toEqual([]);
      expect(built.call).toMatchObject({
        to: STAKE,
        value: '0',
        signer: getAddress(PROVIDER),
        signerRole: 'PROVIDER',
        functionName: 'disputeSlashBatch',
        requestIds: [requestId(1), requestId(2)],
      });
      expect(
        decodeFunctionData({ abi: X402_STAKE_SLASH_ABI, data: built.call!.data as `0x${string}` }),
      ).toMatchObject({
        functionName: 'disputeSlashBatch',
        args: [[`0x${requestId(1)}`, `0x${requestId(2)}`]],
      });
      expect(chain.sent).toHaveLength(0);
    });

    it("refuses per id: unknown, someone else's, not pending, window closed, duplicate", async () => {
      const { chain, executor } = await upgraded();
      chain.markDisputed(requestId(2));
      const other = '0x9999999999999999999999999999999999999999';
      const built = await executor.buildDisputeBatch({
        chainId: CHAIN,
        provider: other,
        requestIds: [requestId(1), requestId(1), requestId(9)],
      });
      expect(built.call).toBeNull();
      expect(built.refusals.map((r) => r.reason)).toEqual([
        'NotSlashedProvider',
        'DuplicateId',
        'NoSuchRecord',
      ]);

      const mine = await executor.buildDisputeBatch({
        chainId: CHAIN,
        provider: PROVIDER,
        requestIds: [requestId(2)],
      });
      expect(mine.refusals.map((r) => r.reason)).toEqual(['SlashNotPending']);

      chain.now += 72n * 3600n;
      const late = await executor.buildDisputeBatch({
        chainId: CHAIN,
        provider: PROVIDER,
        requestIds: [requestId(1)],
      });
      expect(late.refusals.map((r) => r.reason)).toEqual(['DisputeWindowClosed']);
    });

    it("measures the window against the record's executableAt, not a fixed 72 h", async () => {
      const { chain, executor } = build();
      chain.slashDelay = 600n;
      await executor.propose(proposal(1));
      chain.now += 601n;
      const built = await executor.buildDisputeBatch({
        chainId: CHAIN,
        provider: PROVIDER,
        requestIds: [requestId(1)],
      });
      expect(built.refusals.map((r) => r.reason)).toEqual(['DisputeWindowClosed']);
    });

    it('refuses an empty or oversize batch', async () => {
      const { executor } = await upgraded();
      await expect(
        executor.buildDisputeBatch({ chainId: CHAIN, provider: PROVIDER, requestIds: [] }),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_PAYLOAD_MALFORMED' });
      await expect(
        executor.buildDisputeBatch({
          chainId: CHAIN,
          provider: PROVIDER,
          requestIds: Array.from({ length: 65 }, (_, i) => requestId(i + 1)),
        }),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_PAYLOAD_MALFORMED' });
    });
  });

  describe("the arbiter's rulings", () => {
    it('upholds only disputed records, for the arbiter', async () => {
      const { chain, executor } = await upgraded();
      chain.markDisputed(requestId(1));
      const built = await executor.buildRulingBatch({
        chainId: CHAIN,
        ruling: 'UPHOLD',
        requestIds: [requestId(1), requestId(2)],
      });
      expect(built.refusals).toEqual([
        expect.objectContaining({ requestId: requestId(2), reason: 'SlashNotDisputed' }),
      ]);
      const ok = await executor.buildRulingBatch({
        chainId: CHAIN,
        ruling: 'UPHOLD',
        requestIds: [requestId(1)],
      });
      expect(ok.call).toMatchObject({
        signer: ARBITER,
        signerRole: 'ARBITER',
        functionName: 'upholdSlashBatch',
      });
    });

    it('refuses an uphold once the dispute is 30 days old', async () => {
      const { chain, executor } = await upgraded();
      chain.markDisputed(requestId(1));
      chain.now += 30n * 86_400n;
      const built = await executor.buildRulingBatch({
        chainId: CHAIN,
        ruling: 'UPHOLD',
        requestIds: [requestId(1)],
      });
      expect(built.refusals.map((r) => r.reason)).toEqual(['DisputeTimedOut']);
    });

    it("refuses an uphold when the arbiter is the record's verifier", async () => {
      const { chain, executor } = await upgraded();
      chain.arbiter = VERIFIER;
      chain.markDisputed(requestId(1));
      const built = await executor.buildRulingBatch({
        chainId: CHAIN,
        ruling: 'UPHOLD',
        requestIds: [requestId(1)],
      });
      expect(built.refusals.map((r) => r.reason)).toEqual(['ArbiterIsVerifier']);
    });

    it('cancels pending and disputed records together; refuses either ruling with no arbiter', async () => {
      const { chain, executor } = await upgraded();
      chain.markDisputed(requestId(1));
      const built = await executor.buildRulingBatch({
        chainId: CHAIN,
        ruling: 'CANCEL',
        requestIds: [requestId(1), requestId(2)],
      });
      expect(built.call).toMatchObject({ functionName: 'cancelSlashBatch', signer: ARBITER });

      chain.arbiter = '0x0000000000000000000000000000000000000000';
      await expect(
        executor.buildRulingBatch({ chainId: CHAIN, ruling: 'UPHOLD', requestIds: [requestId(1)] }),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_ARBITER_NOT_SET' });
      await expect(
        executor.buildRulingBatch({ chainId: CHAIN, ruling: 'CANCEL', requestIds: [requestId(1)] }),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_ARBITER_NOT_SET' });
    });
  });

  describe('setBlocked', () => {
    const TARGET = '0x7777777777777777777777777777777777777778';

    it('builds a block — never an unblock — for the arbiter', async () => {
      const { executor } = await upgraded();
      const call = await executor.buildBlock({ chainId: CHAIN, account: TARGET });
      expect(call).toMatchObject({
        to: DEPLOYMENT.config,
        signer: ARBITER,
        functionName: 'setBlocked',
      });
      expect(
        decodeFunctionData({ abi: X402_CONFIG_ARBITER_ABI, data: call.data as `0x${string}` }),
      ).toMatchObject({ args: [getAddress(TARGET), true] });
    });

    it('AUDIT E-12: refuses to block any of the platform’s own configured addresses', async () => {
      const { chain, executor } = await upgraded();
      const platform: [string, string][] = [
        [TREASURY, 'treasury'],
        [RELAYER, 'redeemer'],
        [DEPLOYMENT.admin, 'admin'],
        [OWNER, 'owner'],
        [ARBITER, 'arbiter'],
        [DEPLOYMENT.config, 'config contract'],
        [DEPLOYMENT.stake, 'stake contract'],
        [DEPLOYMENT.escrow, 'escrow contract'],
        [chain.verifier, 'verifier key'],
      ];
      for (const [account, role] of platform) {
        await expect(
          executor.buildBlock({ chainId: CHAIN, account: account.toLowerCase() }),
        ).rejects.toMatchObject({
          errorCode: 'CHAIN_PLATFORM_ADDRESS_NOT_BLOCKABLE',
          context: { role },
        });
      }
      await expect(executor.buildBlock({ chainId: CHAIN, account: TARGET })).resolves.toMatchObject(
        { functionName: 'setBlocked' },
      );
    });

    it('refuses an account already blocked, and a chain without an arbiter', async () => {
      const { chain, executor } = await upgraded();
      chain.blockedAccounts.add(getAddress(TARGET));
      await expect(executor.buildBlock({ chainId: CHAIN, account: TARGET })).rejects.toMatchObject({
        errorCode: 'CHAIN_ADDRESS_ALREADY_BLOCKED',
      });
      chain.arbiter = '0x0000000000000000000000000000000000000000';
      await expect(
        executor.buildBlock({
          chainId: CHAIN,
          account: '0x7777777777777777777777777777777777777779',
        }),
      ).rejects.toMatchObject({ errorCode: 'CHAIN_ARBITER_NOT_SET' });
    });
  });

  it('expires a disputed record only after 30 days, naming DisputeUnresolved', async () => {
    const { chain, executor } = await upgraded();
    chain.markDisputed(requestId(1));
    chain.now += 8n * 86_400n + 72n * 3600n;
    await expect(
      executor.expire({ chainId: CHAIN, requestId: requestId(1), provider: PROVIDER }),
    ).rejects.toThrow(/SlashNotExpired/);
    chain.now += 30n * 86_400n;
    await expect(
      executor.expire({ chainId: CHAIN, requestId: requestId(1), provider: PROVIDER }),
    ).resolves.toMatchObject({ reason: 'DISPUTE_UNRESOLVED' });
  });
});
