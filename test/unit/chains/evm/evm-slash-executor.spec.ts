import { Logger } from '@nestjs/common';
import { decodeFunctionData, getAddress, sha256, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { MULTICALL3_ABI, X402_STAKE_SLASH_ABI } from '@modules/chains/evm/abi/x402.abi';
import { EvmSlashExecutor } from '@modules/chains/evm/evm-slash-executor.service';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { chainErrorName } from '@modules/slash/domain/chain-slash-outcome';
import { SlashProposalRequest } from '@modules/slash/ports/slash-executor.port';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

import {
  CHAIN,
  DEPLOYMENT,
  FAKE_ARBITER,
  FakeStakeChain,
  MULTICALL,
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
      receiptRetryDelayMs: 0,
    },
  );
  return { chain, executor, signatures };
}

const multicallSends = (chain: FakeStakeChain) =>
  chain.sent.filter((tx) => getAddress(tx.to) === getAddress(MULTICALL));

describe('EvmSlashExecutor — propose', () => {
  it('signs a SlashAttestation the contract accepts and reports the frozen clock', async () => {
    const { chain, executor, signatures } = build();

    const result = await executor.propose(proposal(1, '150001'));

    const record = chain.record(requestId(1))!;
    expect(record).toMatchObject({ status: 1, penalty: 150_001n, reserved: 150_001n });
    expect(getAddress(record.beneficiary)).toBe(getAddress(AGENTS[1]));
    expect(result).toMatchObject({
      status: 'PENDING',
      adopted: false,
      reservedMinor: '150001',
      proposedAt: new Date(Number(chain.now) * 1000),
      executableAt: new Date(Number(chain.now + 72n * 3600n) * 1000),
    });
    expect(result.signature).toBe(chain.sent[0].hash);
    // One attestation, journalled under the chain it is for.
    expect(signatures).toEqual([
      expect.objectContaining({ chainId: CHAIN, requestId: requestId(1) }),
    ]);
    // Sent to the stake contract — never the multicall for a single judgement.
    expect(getAddress(chain.sent[0].to)).toBe(getAddress(STAKE));
  });

  it('adopts a record already on chain without signing or sending anything', async () => {
    const { chain, executor, signatures } = build();
    await executor.propose(proposal(1));
    const sends = chain.sent.length;

    const again = await executor.propose(proposal(1));

    expect(again).toMatchObject({ adopted: true, status: 'PENDING', signature: '' });
    expect(chain.sent.length).toBe(sends);
    expect(signatures).toHaveLength(1);
  });

  it('names a refusal from simulation and spends no gas on it', async () => {
    const { chain, executor } = build();

    const error = await executor.propose(proposal(1, '1000001')).catch((caught) => caught);

    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_TRANSACTION_FAILED);
    expect(chainErrorName(error)).toBe('PenaltyExceedsMaximum');
    expect(chain.sent).toHaveLength(0);
  });

  it('signs nothing when the verifier key expires before the record could execute (S-7)', async () => {
    const { chain, executor, signatures } = build();
    const grace = 7n * 86_400n;
    // Still registered, but it lapses exactly at `now + delay + grace`.
    chain.verifierExpiresAt = chain.now + chain.slashDelay + grace;

    const error = await executor.propose(proposal(1)).catch((caught) => caught);

    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_CONFIG_VALUE_INVALID);
    expect(signatures).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);

    chain.verifierExpiresAt = chain.now + chain.slashDelay + grace + 1n;
    await expect(executor.propose(proposal(1))).resolves.toMatchObject({ status: 'PENDING' });
  });
});

describe('EvmSlashExecutor — proposeBatch through Multicall3', () => {
  it('puts every per-agent judgement of a window in ONE aggregate3 transaction', async () => {
    const { chain, executor } = build();

    const outcomes = await executor.proposeBatch([proposal(1), proposal(2), proposal(3)]);

    expect(chain.sent).toHaveLength(1);
    expect(getAddress(chain.sent[0].to)).toBe(getAddress(MULTICALL));
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: chain.sent[0].data });
    const calls = args[0] as readonly {
      target: string;
      allowFailure: boolean;
      callData: `0x${string}`;
    }[];
    expect(calls).toHaveLength(3);
    expect(
      calls.every((call) => call.allowFailure && getAddress(call.target) === getAddress(STAKE)),
    ).toBe(true);
    expect(
      calls.map(
        (call) =>
          decodeFunctionData({ abi: X402_STAKE_SLASH_ABI, data: call.callData }).functionName,
      ),
    ).toEqual(['proposeSlash', 'proposeSlash', 'proposeSlash']);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
    expect(outcomes.map((outcome) => outcome.result?.signature)).toEqual([
      chain.sent[0].hash,
      chain.sent[0].hash,
      chain.sent[0].hash,
    ]);
    for (const n of [1, 2, 3]) expect(chain.record(requestId(n))?.status).toBe(1);
  });

  it('estimates the batch and sends it with headroom, under the ceiling', async () => {
    const { chain, executor } = build();
    await executor.proposeBatch([proposal(1), proposal(2), proposal(3)]);
    // Fake estimate for 3 calls: 30 000 + 3 × 120 000 = 390 000; × 1.3.
    expect(chain.sent[0].gasLimit).toBe(507_000n);
  });

  it('takes a call that would fail out of the batch, retries it singly, and reports it — never drops it', async () => {
    const { chain, executor } = build();

    const outcomes = await executor.proposeBatch([
      proposal(1),
      proposal(2, '1000001'), // above penaltyAmount
      proposal(3),
    ]);

    expect(multicallSends(chain)).toHaveLength(1);
    const { args } = decodeFunctionData({ abi: MULTICALL3_ABI, data: chain.sent[0].data });
    expect((args[0] as readonly unknown[]).length).toBe(2);
    // The single retry was refused in simulation: no second transaction.
    expect(chain.sent).toHaveLength(1);

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[2].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);
    expect(chainErrorName(outcomes[1].error)).toBe('PenaltyExceedsMaximum');
  });

  it('is idempotent on the request id: a retried batch adopts every record and sends nothing', async () => {
    const { chain, executor, signatures } = build();
    await executor.proposeBatch([proposal(1), proposal(2)]);
    const sends = chain.sent.length;
    const signed = signatures.length;

    const again = await executor.proposeBatch([proposal(1), proposal(2)]);

    expect(again.map((outcome) => outcome.result?.adopted)).toEqual([true, true]);
    expect(chain.sent.length).toBe(sends);
    expect(signatures.length).toBe(signed);
  });

  it('treats SlashAlreadyExists on the single retry as success-already', async () => {
    const { chain, executor } = build();
    // A stranger lands request 2 between our simulation and our send. Inside
    // the batch its call reverts SlashAlreadyExists (allowFailure keeps the
    // others); the receipt lacks its event; the single retry finds the record
    // and adopts it.
    chain.beforeSend = () => {
      chain.state.records.set(requestId(2), {
        provider: getAddress(PROVIDER),
        status: 1,
        penalty: 100_000n,
        beneficiary: getAddress(AGENTS[2]),
        proposedAt: chain.now,
        verifier: chain.verifier,
        executableAt: chain.now + 72n * 3600n,
        reserved: 100_000n,
        capAllowance: 20_000_000n,
        applied: 0n,
        executedAt: 0n,
        // Landed from OUR attestation (e.g. an earlier send that was slow):
        // same signed policy, same verifier.
        policy: sha256(toBytes('tool-uuid')),
      });
      chain.beforeSend = null;
    };

    const outcomes = await executor.proposeBatch([proposal(1), proposal(2), proposal(3)]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
    expect(outcomes[0].result?.adopted).toBe(false);
    expect(outcomes[1].result?.adopted).toBe(true);
    expect(chain.sent).toHaveLength(1);
  });

  it('retries singly every call whose event is missing from the batch receipt', async () => {
    const { chain, executor } = build();
    // Change the state under the batch so call 2 fails INSIDE it: the
    // receipt then lacks its SlashProposed, and the single retry names why.
    chain.beforeSend = (data) => {
      if (getAddress(chain.sent[chain.sent.length - 1].to) !== getAddress(MULTICALL)) return;
      void data;
      chain.params = { ...chain.params, penaltyAmount: 100_000n };
    };

    const outcomes = await executor.proposeBatch([
      proposal(1, '100000'),
      proposal(2, '100001'),
      proposal(3, '100000'),
    ]);

    expect(outcomes[0].ok).toBe(true);
    expect(outcomes[2].ok).toBe(true);
    expect(outcomes[1].ok).toBe(false);
    expect(chainErrorName(outcomes[1].error)).toBe('PenaltyExceedsMaximum');
  });

  it('chunks beyond the batch size, one aggregate3 per chunk', async () => {
    const { chain, executor } = build({ batchSize: 2 });

    const outcomes = await executor.proposeBatch([1, 2, 3, 4, 5].map((n) => proposal(n, '50000')));

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    // [1,2] and [3,4] batched; the lone [5] goes through the single door.
    expect(multicallSends(chain)).toHaveLength(2);
    expect(chain.sent).toHaveLength(3);
  });

  it('falls back to one transaction per judgement when no Multicall3 is configured', async () => {
    const { chain, executor } = build({ multicall: false });

    const outcomes = await executor.proposeBatch([proposal(1), proposal(2), proposal(3)]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(multicallSends(chain)).toHaveLength(0);
    expect(chain.sent).toHaveLength(3);
  });
});

describe('EvmSlashExecutor — execute', () => {
  async function proposed(count: number, penalty = '150001') {
    const built = build();
    await built.executor.proposeBatch(
      Array.from({ length: count }, (_, i) => proposal(i + 1, penalty)),
    );
    built.chain.now += 72n * 3600n;
    built.chain.sent.length = 0;
    return built;
  }

  it('executes every matured judgement in one batch and reports the 60/30 the chain paid', async () => {
    const { chain, executor } = await proposed(3);

    const outcomes = await executor.executeBatch(
      [1, 2, 3].map((n) => ({
        chainId: CHAIN,
        requestId: requestId(n),
        provider: PROVIDER,
        beneficiary: AGENTS[n],
      })),
    );

    expect(chain.sent).toHaveLength(1);
    expect(getAddress(chain.sent[0].to)).toBe(getAddress(MULTICALL));
    for (const outcome of outcomes) {
      expect(outcome.result).toMatchObject({
        appliedMinor: '150001',
        agentAmountMinor: '90000', // ⌊150 001 × 0.6⌋
        platformAmountMinor: '45000', // ⌊150 001 × 0.3⌋
        signature: chain.sent[0].hash,
      });
    }
    for (const n of [1, 2, 3]) expect(chain.balanceOf(AGENTS[n])).toBe(90_000n);
    expect(chain.balanceOf(TREASURY)).toBe(135_000n);
  });

  it('refuses before any gas when the case names a different beneficiary than the record', async () => {
    const { chain, executor } = await proposed(1);

    const error = await executor
      .executeProposal({
        chainId: CHAIN,
        requestId: requestId(1),
        provider: PROVIDER,
        beneficiary: AGENTS[4],
      })
      .catch((caught) => caught);

    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_PAYLOAD_MALFORMED);
    expect(chain.sent).toHaveLength(0);
  });

  it('names SlashNotYetExecutable from simulation before the door opens', async () => {
    const { chain, executor } = build();
    await executor.propose(proposal(1));
    chain.sent.length = 0;

    const error = await executor
      .executeProposal({
        chainId: CHAIN,
        requestId: requestId(1),
        provider: PROVIDER,
        beneficiary: AGENTS[1],
      })
      .catch((caught) => caught);

    expect(chainErrorName(error)).toBe('SlashNotYetExecutable');
    expect(chain.sent).toHaveLength(0);
  });

  it('says CHAIN_SLASH_RECORD_NOT_FOUND — terminal — for a request never proposed', async () => {
    const { executor } = build();
    const error = await executor
      .executeProposal({
        chainId: CHAIN,
        requestId: requestId(9),
        provider: PROVIDER,
        beneficiary: AGENTS[1],
      })
      .catch((caught) => caught);
    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND);
  });
});

describe('EvmSlashExecutor — reads, cancel, expire, caps', () => {
  it('reads null for an untouched request id, and the record otherwise', async () => {
    const { executor } = build();
    await expect(executor.readRecord(requestId(1), PROVIDER, CHAIN)).resolves.toBeNull();
    await executor.propose(proposal(1, '100000'));
    await expect(executor.readRecord(requestId(1), PROVIDER, CHAIN)).resolves.toMatchObject({
      status: 'PENDING',
      penaltyMinor: '100000',
      reservedMinor: '100000',
      executedAt: null,
    });
  });

  it('builds the arbiter’s unsigned cancelSlash and sends nothing', async () => {
    const { chain, executor } = build();
    await executor.propose(proposal(1));
    chain.sent.length = 0;

    const intent = await executor.buildCancel({
      chainId: CHAIN,
      requestId: requestId(1),
      provider: PROVIDER,
    });

    expect(
      decodeFunctionData({ abi: X402_STAKE_SLASH_ABI, data: intent.transaction as `0x${string}` }),
    ).toMatchObject({
      functionName: 'cancelSlash',
      args: [`0x${requestId(1)}`],
    });
    expect(intent.to).toBe(STAKE);
    expect(intent).toMatchObject({ admin: FAKE_ARBITER, signerRole: 'ARBITER' });
    expect(chain.sent).toHaveLength(0);
  });

  it('expires a record once its verifier key is revoked', async () => {
    const { chain, executor } = build();
    await executor.propose(proposal(1));
    chain.revoked = true;

    const result = await executor.expire({
      chainId: CHAIN,
      requestId: requestId(1),
      provider: PROVIDER,
    });

    expect(chain.record(requestId(1))?.status).toBe(3);
    expect(result.signature).toBe(chain.sent[chain.sent.length - 1].hash);
  });

  it('reads the caps proposeSlash will apply', async () => {
    const { executor } = build();
    await expect(executor.readCaps({ chainId: CHAIN, provider: PROVIDER })).resolves.toEqual({
      penaltyCeilingMinor: 1_000_000n,
      windowAllowanceMinor: 20_000_000n, // 10% of 200 USDG at risk
      freeStakeMinor: 199_000_000n, // minus reqA's 1 USDG reservation
      verifierDailyCapMinor: 500_000_000n,
      agentBps: 6000,
      platformBps: 3000,
    });
  });
});

describe('review fixes — EvmSlashExecutor', () => {
  // S1-1: a prepared attestation must never be reused by the single retry.
  it('re-signs every single retry, so a slow batch send cannot expire its attestations', async () => {
    const { chain, executor, signatures } = build();
    const send = chain.relayer.sendCall;
    chain.relayer.sendCall = async (call) => {
      if (call.to.toLowerCase().endsWith(MULTICALL.slice(2).toLowerCase())) {
        chain.now += 700n; // longer than the 600 s attestation lifetime
        throw new Error('timeout waiting for receipt');
      }
      return send(call);
    };

    const outcomes = await executor.proposeBatch([proposal(1), proposal(2), proposal(3)]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, true]);
    // 3 for the batch, 3 fresh ones for the singles.
    expect(signatures).toHaveLength(6);
  });

  it('does not trust a permanent refusal while the batch carrying the request may still land', async () => {
    const { chain, executor } = build();
    const send = chain.relayer.sendCall;
    chain.relayer.sendCall = async (call) => {
      if (call.to.toLowerCase().endsWith(MULTICALL.slice(2).toLowerCase())) {
        // The node dropped the connection: the batch may or may not be mined.
        // Meanwhile the ceiling moved, so a fresh single attempt is refused.
        chain.params = { ...chain.params, penaltyAmount: 50_000n };
        throw new Error('socket hang up');
      }
      return send(call);
    };

    const outcomes = await executor.proposeBatch([proposal(1), proposal(2)]);

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      // Unnamed → TRANSIENT: retried and re-read, never REFUSED or voided now.
      expect(chainErrorName(outcome.error)).toBeNull();
    }
  });

  // S2-3: never sign an attestation whose beneficiary is a platform contract,
  // the treasury, the provider itself, or nobody.
  it.each([
    ['the zero address', '0x0000000000000000000000000000000000000000'],
    ['the escrow (vault)', DEPLOYMENT.escrow],
    ['the stake contract', DEPLOYMENT.stake],
    ['the config contract', DEPLOYMENT.config],
    ['the treasury', TREASURY],
    ['the provider', PROVIDER],
  ])('refuses %s as beneficiary before signing', async (_label, beneficiary) => {
    const { chain, executor, signatures } = build();
    const error = await executor
      .propose(proposal(1, '100000', beneficiary))
      .catch((caught) => caught);
    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_PAYLOAD_MALFORMED);
    expect(signatures).toHaveLength(0);
    expect(chain.sent).toHaveLength(0);
  });

  // S3(2): adoption must match the whole judgement, not just the beneficiary.
  it.each([
    ['penalty', { penalty: 1n }],
    ['policy', { policy: `0x${'11'.repeat(32)}` }],
    ['verifier', { verifier: '0x9999999999999999999999999999999999999999' }],
  ])('refuses to adopt a record whose %s differs', async (_field, override) => {
    const { chain, executor } = build();
    await executor.propose(proposal(1, '100000'));
    Object.assign(chain.record(requestId(1))!, override);

    const error = await executor.propose(proposal(1, '100000')).catch((caught) => caught);

    expect(error.errorCode).toBe(ChainErrorCode.CHAIN_PAYLOAD_MALFORMED);
  });

  it('adopts a record signed by a rotated key the chain still allows', async () => {
    const { chain, executor } = build();
    await executor.propose(proposal(1, '100000'));
    const rotated = '0x7777777777777777777777777777777777777777';
    Object.assign(chain.record(requestId(1))!, { verifier: rotated });
    chain.alsoRegistered.add(getAddress(rotated));

    await expect(executor.propose(proposal(1, '100000'))).resolves.toMatchObject({ adopted: true });
  });

  it('reports the signed terms on readRecord, so the parts service can judge them', async () => {
    const { executor } = build();
    await executor.propose(proposal(1, '100000'));
    await expect(executor.readRecord(requestId(1), PROVIDER, CHAIN)).resolves.toMatchObject({
      beneficiary: getAddress(AGENTS[1]),
      policy: sha256(toBytes('tool-uuid')),
      verifier: VERIFIER,
      verifierCanSign: true,
      verifierAccepted: true,
    });
  });

  // S3(1): one chunk's RPC failure must not fail the others or lose a row.
  it('isolates a chunk whose simulation RPC fails, retrying its rows singly', async () => {
    const { chain, executor } = build({ batchSize: 2 });
    chain.failNextCalls = 1; // the first chunk's aggregate3 simulation

    const outcomes = await executor.proposeBatch([1, 2, 3, 4].map((n) => proposal(n, '50000')));

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    for (const n of [1, 2, 3, 4]) expect(chain.record(requestId(n))?.status).toBe(1);
  });

  it('keeps the receipt amounts of a batched execution whose receipt read failed once', async () => {
    const { chain, executor } = build();
    await executor.proposeBatch([proposal(1, '150001'), proposal(2, '150001')]);
    chain.now += 72n * 3600n;
    // The batch lands; its first receipt read fails.
    const send = chain.relayer.sendCall;
    chain.relayer.sendCall = async (call) => {
      const result = await send(call);
      chain.failReceipts.set(result.hash, 1);
      return result;
    };

    const outcomes = await executor.executeBatch(
      [1, 2].map((n) => ({
        chainId: CHAIN,
        requestId: requestId(n),
        provider: PROVIDER,
        beneficiary: AGENTS[n],
      })),
    );

    expect(outcomes.map((outcome) => outcome.result?.agentAmountMinor)).toEqual(['90000', '90000']);
    expect(outcomes.map((outcome) => outcome.result?.signature)).toEqual([
      chain.sent.at(-1)!.hash,
      chain.sent.at(-1)!.hash,
    ]);
  });

  // S2-2: the contract truncates to the remaining windows and discharges the
  // rest. A case that would be cut is deferred whole, never cut by order.
  describe('remaining caps at execution', () => {
    async function twoCases() {
      const built = build();
      built.chain.params = { ...built.chain.params, penaltyAmount: 10_000_000n };
      await built.executor.proposeBatch([
        proposal(1, '4000000', AGENTS[1]),
        proposal(2, '4000000', AGENTS[2]),
        proposal(3, '3000000', AGENTS[3]),
        proposal(4, '3000000', AGENTS[4]),
      ]);
      built.chain.now += 72n * 3600n;
      // 10 USDG of the provider's 20 USDG window is already used, just now.
      const stake = built.chain.state.stakes.get(getAddress(PROVIDER))!;
      stake.slashedInWindow = 10_000_000n;
      stake.slashWindowStartedAt = built.chain.now;
      built.chain.sent.length = 0;
      const requests = [1, 2, 3, 4].map((n) => ({
        chainId: CHAIN,
        requestId: requestId(n),
        provider: PROVIDER,
        beneficiary: AGENTS[n],
        atomicGroup: n <= 2 ? 'case-A' : 'case-B',
      }));
      return { ...built, requests };
    }

    it('all or wait: pays what fits in full, and the rest waits with SlashWindowNotDrained', async () => {
      const { chain, executor, requests } = await twoCases();

      const outcomes = await executor.executeBatch(requests);

      // 10 of the 20 USDG window is used: case A (4 + 4) fits whole, and
      // case B (3 + 3) would need 14 — its parts wait, nothing is cut.
      expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true, false, false]);
      expect(outcomes.slice(0, 2).map((outcome) => outcome.result?.appliedMinor)).toEqual([
        '4000000',
        '4000000',
      ]);
      expect(chainErrorName(outcomes[2].error)).toBe('SlashWindowNotDrained');
      expect(chainErrorName(outcomes[3].error)).toBe('SlashWindowNotDrained');
      for (const n of [3, 4]) expect(chain.record(requestId(n))?.status).toBe(1);
      for (const n of [1, 2]) expect(chain.record(requestId(n))?.applied).toBe(4_000_000n);
    });

    it('logs an error if an execution ever applies other than the reserved amount', async () => {
      const { chain, executor, requests } = await twoCases();
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      let sent = false;
      chain.beforeSend = () => {
        sent = true;
      };
      const read = chain.client.readContract;
      chain.client.readContract = async (args) => {
        const value = await read(args);
        if (sent && args.functionName === 'slashRecordOf') {
          return { ...(value as object), reserved: 1n };
        }
        return value;
      };
      const [outcome] = await executor.executeBatch(requests.slice(0, 1));
      expect(outcome.result?.appliedMinor).toBe('4000000');
      expect(error).toHaveBeenCalledWith(
        expect.stringMatching(/applied 4000000, but the record reserved 1/),
      );
      error.mockRestore();
    });

    it('pays a waiting part in full once the window has drained', async () => {
      const { chain, executor, requests } = await twoCases();
      await executor.executeBatch(requests);
      chain.now += 86_400n;

      const outcomes = await executor.executeBatch(requests.slice(2));

      expect(outcomes.map((outcome) => outcome.result?.appliedMinor)).toEqual([
        '3000000',
        '3000000',
      ]);
    });
  });
});
