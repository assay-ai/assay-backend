import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';

import {
  Address,
  getAddressDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { Ed25519Program } from '@solana/web3.js';
import {
  ATTESTATION_DOMAINS,
  CANCEL_SLASH_DISCRIMINATOR,
  findConfigPda,
  findSlashRecordPda,
  findStakePda,
  findVerifierKeyPda,
  getConfigEncoder,
  getSlashRecordEncoder,
  SIGNED_RESPONSE_CLASS,
  SLASH_MESSAGE_LENGTH,
  slashAttestationMessage,
  SlashStatus,
} from '@assay/settlement-client';

import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import {
  FEE_PAYER_SIGNER,
  FeePayerSignerPort,
  FeePayerSignResult,
} from '@modules/chains/facilitator/signing/fee-payer-signer.port';
import {
  SlashExecutorRpcClient,
  SolanaSlashExecutor,
} from '@modules/chains/solana/settlement-slash-executor.service';
import { SlashProposalRequest } from '@modules/slash/ports/slash-executor.port';
import { SigningRequesterType } from '@modules/verification/signing/domain/signing-journal';

/**
 * `SolanaSlashExecutor` — the only path in `src/` that may submit any phase of
 * the slash lifecycle.
 *
 * ## The fake sits at the RPC and at `ModuleRef`, not at the port
 *
 * Same trade `settlement-stake-reader.spec.ts` makes: the account bytes are
 * produced by the generated encoder and read by the real decoder, the
 * instructions are built by the real generated builders, and the attestation
 * bytes are the real `slashAttestationMessage`. Faking `SlashExecutorPort`
 * would have made every assertion below a restatement of the fake — which is
 * exactly the failure mode
 * this class exists to rule out: a `u64` at the wrong offset here is a number a
 * dispute later argues about.
 *
 * `ModuleRef` is faked rather than constructed for real, because the real
 * `VerifierSigningService` needs a journal repository, a rate limiter, an
 * alert port, a key directory and a config object — none of which this suite
 * is about. The fake speaks the two methods `SolanaSlashExecutor` calls,
 * `sign()` and `publicKey()`, and `get(token, { strict: false })` exactly as
 * `ModuleRef.get` does. See `AttestationSigner` on the class under test.
 *
 * Nothing here touches a network or a chain.
 */

const PROGRAM_ADDRESS = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S' as Address;
/** The one Solana chain this executor is wired to submit on. */
const SOLANA_CHAIN = CHAIN_IDS.SOLANA_DEVNET;
const BLOCKHASH = '11111111111111111111111111111111';
const ED25519_PROGRAM_ADDRESS = Ed25519Program.programId.toBase58() as Address;

const REQUEST_ID = 'a1'.repeat(32);
const PROVIDER = addressOf(9);
const BENEFICIARY = addressOf(10);
const STAKE_MINT = addressOf(11);
const TREASURY = addressOf(12);
/** `Config.admin` — `cancel_slash`'s only signer, and a key this codebase never holds. */
const ADMIN = addressOf(13);

/** The chain's clocks, as the fixtures below write them. 72h apart, exactly. */
const PROPOSED_AT_SECONDS = 1_800_000_000n;
const EXECUTABLE_AT_SECONDS = 1_800_259_200n;
const EXECUTED_AT_SECONDS = 1_800_259_300n;
const CANCELLED_AT_SECONDS = 1_800_100_000n;

function addressOf(seed: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(seed));
}

/** A fixed ed25519 seed, so the verifier's address is the same on every run. */
const VERIFIER_SEED = Uint8Array.from({ length: 32 }, (_, index) => index + 21);
/** WebCrypto/Node import ed25519 private keys as PKCS#8 and nothing else. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function fixedVerifierKeypair() {
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(VERIFIER_SEED)]);
  const privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKey = new Uint8Array(spki.subarray(12));
  return {
    publicKey,
    address: getAddressDecoder().decode(publicKey),
    sign: (message: Uint8Array) =>
      new Uint8Array(signEd25519(null, Buffer.from(message), privateKey)),
  };
}

/**
 * The narrow shape `SolanaSlashExecutor` actually calls on
 * `VerifierSigningService` — see `AttestationSigner` on the class under test.
 * Records every request so tests can assert on `purpose` and `requestedBy`
 * without needing the real journal.
 *
 * `publicKey()` is counted separately from `sign()` on purpose: the whole reason
 * it exists is that reading the key's *address* must not put a row in the
 * signing journal, and a test that could not tell the two apart could not hold
 * that line.
 */
class FakeAttestationSigner {
  readonly calls: Array<{
    chainId: ChainId;
    purpose: string;
    requestId: string | null;
    requestedBy: { type: SigningRequesterType; id: string };
    payload: Uint8Array;
  }> = [];

  publicKeyReads = 0;

  /** Every chain the executor asked about, in order. */
  readonly chainsAsked: ChainId[] = [];

  constructor(private readonly keypair = fixedVerifierKeypair()) {}

  async publicKey(chainId: ChainId): Promise<Uint8Array> {
    this.publicKeyReads += 1;
    this.chainsAsked.push(chainId);
    return this.keypair.publicKey;
  }

  async sign(request: {
    chainId: ChainId;
    purpose: string;
    requestId: string | null;
    requestedBy: { type: SigningRequesterType; id: string };
    payload: Uint8Array;
  }) {
    this.calls.push(request);
    this.chainsAsked.push(request.chainId);
    return {
      keyId: 'fake-verifier',
      publicKey: this.keypair.publicKey,
      signature: this.keypair.sign(request.payload),
      journalId: 'fake-journal-id',
      signedAt: new Date(),
    };
  }
}

/**
 * `ModuleRef.get(VerifierSigningService, { strict: false })` and
 * `ModuleRef.get(FEE_PAYER_SIGNER, { strict: false })`, and nothing else.
 */
class FakeModuleRef {
  constructor(private readonly resolve: (token: unknown) => unknown) {}

  get(token: unknown, _options?: unknown): unknown {
    return this.resolve(token);
  }
}

/** The platform fee-payer key, as `reverse_slash`'s restorer sees it. */
const FEE_PAYER_ADDRESS = addressOf(30);

/**
 * `FeePayerSignerPort`, forwarding to the same `FakeRpc.sendTransaction` the
 * verifier-signed doors use, so every test reads what was sent from one place
 * and `failNextSend` refuses a reversal exactly as it refuses an execution.
 * Signs nothing: no test here verifies a transaction signature, only what the
 * compiled message names.
 */
class FakeFeePayer implements FeePayerSignerPort {
  readonly name = 'fake-fee-payer';
  readonly wires: string[] = [];

  constructor(private readonly rpc: FakeRpc) {}

  async getFeePayerAddress(): Promise<Address> {
    return FEE_PAYER_ADDRESS;
  }

  async signAndSend(rawTransactionBase64: string): Promise<FeePayerSignResult> {
    this.wires.push(rawTransactionBase64);
    const signature = await this.rpc.sendTransaction(rawTransactionBase64).send();
    return { signature, signedTransaction: rawTransactionBase64 };
  }
}

interface RecordFields {
  readonly penalty: bigint;
  readonly applied: bigint;
  readonly agentAmount?: bigint;
  readonly platformAmount?: bigint;
  readonly attestedAt: bigint;
  readonly executedAt: bigint;
  readonly status: SlashStatus;
  readonly proposedAt: bigint;
  readonly executableAt: bigint;
  readonly reserved: bigint;
  readonly capAllowance?: bigint;
  readonly cancelledAt?: bigint;
}

/** A `SlashRecord` in `Pending` — what `propose_slash` leaves behind. */
function pendingRecord(): RecordFields {
  return {
    penalty: 1_000n,
    applied: 0n,
    agentAmount: 0n,
    platformAmount: 0n,
    attestedAt: PROPOSED_AT_SECONDS,
    executedAt: 0n,
    status: SlashStatus.Pending,
    proposedAt: PROPOSED_AT_SECONDS,
    executableAt: EXECUTABLE_AT_SECONDS,
    reserved: 900n,
    capAllowance: 900n,
    cancelledAt: 0n,
  };
}

/** The same record after `execute_slash`: 900 taken, split 60/30. */
function executedRecord(): RecordFields {
  return {
    ...pendingRecord(),
    status: SlashStatus.Executed,
    applied: 900n,
    agentAmount: 540n,
    platformAmount: 270n,
    executedAt: EXECUTED_AT_SECONDS,
  };
}

/** The same record after `cancel_slash` or `expire_slash`: nothing taken. */
function cancelledRecord(): RecordFields {
  return {
    ...pendingRecord(),
    status: SlashStatus.Cancelled,
    cancelledAt: CANCELLED_AT_SECONDS,
  };
}

function encodeSlashRecord(fields: RecordFields): string {
  const bytes = getSlashRecordEncoder().encode({
    requestId: Buffer.from(REQUEST_ID, 'hex'),
    provider: PROVIDER,
    beneficiary: BENEFICIARY,
    verifier: fixedVerifierKeypair().address,
    policy: new Uint8Array(32).fill(0xcc),
    penalty: fields.penalty,
    applied: fields.applied,
    agentAmount: fields.agentAmount ?? 0n,
    platformAmount: fields.platformAmount ?? 0n,
    slashAgentBps: 6_000,
    slashPlatformBps: 3_000,
    attestedAt: fields.attestedAt,
    executedAt: fields.executedAt,
    status: fields.status,
    proposedAt: fields.proposedAt,
    executableAt: fields.executableAt,
    reserved: fields.reserved,
    capAllowance: fields.capAllowance ?? fields.reserved,
    cancelledAt: fields.cancelledAt ?? 0n,
    bump: 253,
  });
  return Buffer.from(bytes).toString('base64');
}

/**
 * `Config`, which since the contract simplification carries the economics too — the treasury and
 * the admin among them. `EconomicsConfig` is gone, and so is the second
 * `getAccountInfo` this service used to make to read it.
 */
function encodeConfig(): string {
  const bytes = getConfigEncoder().encode({
    admin: ADMIN,
    stakeMint: STAKE_MINT,
    treasury: TREASURY,
    unbondingPeriodSeconds: 1_209_600n,
    takeRateBps: 1_000,
    slashAgentBps: 6_000,
    slashPlatformBps: 3_000,
    slashCapBps: 1_000,
    minimumStake: 10_000_000n,
    penaltyAmount: 1_000_000n,
    // The per-key rolling budget `execute_slash` meters against.
    verifierDailyCap: 100_000_000n,
    paused: false,
    totalStaked: 0n,
    totalDeposited: 0n,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    bump: 255,
    vaultBump: 254,
    // `Config.redeemer` — the only key `redeem_voucher` accepts as `rent_payer`.
    redeemer: ADMIN,
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

/** The four RPC calls this service makes, and nothing else. */
class FakeRpc implements SlashExecutorRpcClient {
  readonly accounts = new Map<string, string>();
  readonly sent: string[] = [];
  /**
   * What the next `sendTransaction` rejects with. A string is wrapped in an
   * `Error`; anything else is thrown as-is, so a test can reproduce the shape
   * a real preflight rejection has rather than only its text.
   */
  failNextSend: unknown = null;

  getAccountInfo(account: Address) {
    return {
      send: async () => {
        const data = this.accounts.get(account);
        return { value: data ? { data: [data, 'base64'] as const } : null };
      },
    };
  }

  getLatestBlockhash() {
    return {
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    };
  }

  sendTransaction(base64Transaction: string) {
    return {
      send: async () => {
        if (this.failNextSend !== null) {
          const failure = this.failNextSend;
          this.failNextSend = null;
          throw typeof failure === 'string' ? new Error(failure) : failure;
        }
        this.sent.push(base64Transaction);
        return 'submitted';
      },
    };
  }

  getSignatureStatuses() {
    return {
      send: async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' as const }] }),
    };
  }
}

/** What the last `sendTransaction` actually carried. */
function decodeSent(rpc: FakeRpc) {
  const bytes = new Uint8Array(getBase64Encoder().encode(rpc.sent[rpc.sent.length - 1]));
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error(`expected a v0 compiled message, got version ${String(message.version)}`);
  }
  return { transaction, message };
}

/** The addresses one compiled instruction actually names, resolved off the table. */
function accountsOf(
  message: ReturnType<typeof decodeSent>['message'],
  index: number,
): readonly Address[] {
  const instruction = message.instructions[index];
  return (instruction.accountIndices ?? []).map((i) => message.staticAccounts[i]);
}

async function seedPdas(rpc: FakeRpc, record: RecordFields | null) {
  const [[configPda], [slashRecordPda]] = await Promise.all([
    findConfigPda({ programAddress: PROGRAM_ADDRESS }),
    findSlashRecordPda(
      { requestId: Buffer.from(REQUEST_ID, 'hex') },
      { programAddress: PROGRAM_ADDRESS },
    ),
  ]);
  rpc.accounts.set(configPda, encodeConfig());
  // `stake` and `verifierKey` are derived, never decoded by this service, so
  // nothing is seeded at their addresses — it never calls `getAccountInfo` on
  // them.
  if (record) {
    rpc.accounts.set(slashRecordPda, encodeSlashRecord(record));
  }
}

function build(
  rpc: FakeRpc,
  signer: FakeAttestationSigner,
  programId: string | null = PROGRAM_ADDRESS,
  feePayer: FeePayerSignerPort | null = new FakeFeePayer(rpc),
) {
  const moduleRef = new FakeModuleRef((token) => {
    if (token === FEE_PAYER_SIGNER) {
      if (!feePayer) {
        throw new Error('could not resolve FEE_PAYER_SIGNER in the current context');
      }
      return feePayer;
    }
    return signer;
  });
  return new SolanaSlashExecutor(rpc, programId, SOLANA_CHAIN, moduleRef as never);
}

const PROPOSE_REQUEST: SlashProposalRequest = {
  chainId: SOLANA_CHAIN,
  requestId: REQUEST_ID,
  provider: PROVIDER,
  beneficiary: BENEFICIARY,
  penaltyMinor: '1000',
  policy: 'unit-test-policy',
  responseClass: 'dataFail',
};

const EXECUTE_REQUEST = {
  chainId: SOLANA_CHAIN,
  requestId: REQUEST_ID,
  provider: PROVIDER,
  beneficiary: BENEFICIARY,
};

const CANCEL_REQUEST = { chainId: SOLANA_CHAIN, requestId: REQUEST_ID, provider: PROVIDER };

describe('SolanaSlashExecutor', () => {
  describe('propose (propose_slash)', () => {
    it('signs an attestation of the right length carrying the slash domain tag', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).propose(PROPOSE_REQUEST);

      // First call is the attestation; the second (transaction fee-payer
      // signature) is a different message of a different shape entirely.
      const attestationCall = signer.calls[0];
      expect(attestationCall.purpose).toBe('settlement.propose_slash.attestation');
      expect(attestationCall.payload).toHaveLength(SLASH_MESSAGE_LENGTH);
      expect(
        Buffer.from(attestationCall.payload.subarray(0, ATTESTATION_DOMAINS.slash.length)),
      ).toEqual(Buffer.from(ATTESTATION_DOMAINS.slash));

      // The policy field is a sha256 of the port's `policy: string` — checked
      // independently, since it is the one field this service computes rather
      // than passes through.
      const policyDigest = attestationCall.payload.slice(163, 195);
      expect(Buffer.from(policyDigest)).toEqual(
        createHash('sha256').update(PROPOSE_REQUEST.policy, 'utf8').digest(),
      );

      // And the rest of the message is the real one for these exact fields —
      // an independent recomputation, not read back from what the service
      // happened to send.
      const expected = slashAttestationMessage({
        requestId: Buffer.from(REQUEST_ID, 'hex'),
        provider: PROVIDER,
        beneficiary: BENEFICIARY,
        status: SIGNED_RESPONSE_CLASS.dataFail,
        penalty: 1_000n,
        policy: policyDigest,
        issuedAt: readI64(attestationCall.payload, 195),
        expiresAt: readI64(attestationCall.payload, 203),
        programAddress: PROGRAM_ADDRESS,
      });
      expect(Buffer.from(attestationCall.payload)).toEqual(Buffer.from(expected));
    });

    it('sends exactly two instructions, the ed25519 precompile before propose_slash', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).propose(PROPOSE_REQUEST);

      const { message } = decodeSent(rpc);
      expect(message.instructions).toHaveLength(2);
      const [precompile, propose] = message.instructions;
      expect(message.staticAccounts[precompile.programAddressIndex]).toBe(ED25519_PROGRAM_ADDRESS);
      expect(message.staticAccounts[propose.programAddressIndex]).toBe(PROGRAM_ADDRESS);
    });

    it('targets the record the seeds imply, and touches no token account at all', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).propose(PROPOSE_REQUEST);

      const { message } = decodeSent(rpc);
      const accounts = accountsOf(message, 1);

      const [slashRecordPda] = await findSlashRecordPda(
        { requestId: Buffer.from(REQUEST_ID, 'hex') },
        { programAddress: PROGRAM_ADDRESS },
      );
      expect(accounts).toContain(slashRecordPda);

      // No token account is in the instruction, and that absence is the check:
      // this phase cannot move a lamport however it is driven.
      expect(accounts).not.toContain(STAKE_MINT);
      expect(accounts).not.toContain(TREASURY);
    });

    it('reads the timelock clock and the reservation off the chain, never off this process', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      const result = await build(rpc, signer).propose(PROPOSE_REQUEST);

      expect(result.proposedAt).toEqual(new Date(1_800_000_000_000));
      expect(result.executableAt).toEqual(new Date(1_800_259_200_000));
      expect(result.reservedMinor).toBe('900');
      expect(result.adopted).toBe(false);
      expect(result.status).toBe('PENDING');
      expect(result.signature).not.toBe('');
    });

    it('adopts an existing record instead of writing a second penalty', async () => {
      // The retry path: a crash between send and confirm leaves a record on
      // chain, and `init` refuses the second proposal. Adopting is the only
      // answer that cannot mint a second judgement for one finding.
      //
      // The rejection here is what the RPC ACTUALLY returns for that case, and
      // the point of the test is that it does not say "already in use"
      // anywhere. `SystemError::AccountAlreadyInUse` is not an Anchor error: it
      // renders as `Allocate: … already in use` in the simulation *logs* and
      // reaches the message only as `custom program error: 0x0`. Deciding
      // adoption by reading the record rather than the text is what makes this
      // pass.
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      rpc.failNextSend = Object.assign(
        new Error(
          'failed to send transaction: Transaction simulation failed: ' +
            'Error processing Instruction 1: custom program error: 0x0',
        ),
        { context: { logs: ['Allocate: account Address { … } already in use'] } },
      );
      const signer = new FakeAttestationSigner();

      const result = await build(rpc, signer).propose(PROPOSE_REQUEST);

      expect(result.adopted).toBe(true);
      expect(result.status).toBe('PENDING');
      expect(result.signature).toBe('');
      expect(result.executableAt).toEqual(new Date(1_800_259_200_000));
      expect(result.reservedMinor).toBe('900');
      expect(rpc.sent).toHaveLength(0);
    });

    /**
     * Neither `cancel_slash` nor `expire_slash` closes the account, so what a
     * second proposal collides with may be a finished judgement rather than a
     * live one. Adopting it silently would hand the caller a `Pending`-shaped
     * result with a timelock, and the execution it scheduled would fail 72h
     * later. The status travels so the caller can close the case instead.
     */
    it('reports the adopted record’s real status, which need not be pending', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, cancelledRecord());
      rpc.failNextSend = new Error('custom program error: 0x0');
      const signer = new FakeAttestationSigner();

      const result = await build(rpc, signer).propose(PROPOSE_REQUEST);

      expect(result.adopted).toBe(true);
      expect(result.status).toBe('CANCELLED');
      expect(rpc.sent).toHaveLength(0);
    });

    it('throws, rather than adopting, when no record exists to adopt', async () => {
      // The same failure with nothing on chain: a transient send failure on a
      // first attempt. Adoption must not be inferred from the failure alone.
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      rpc.failNextSend = 'blockhash not found';
      const signer = new FakeAttestationSigner();

      await expect(build(rpc, signer).propose(PROPOSE_REQUEST)).rejects.toThrow(
        'blockhash not found',
      );
    });

    it('fails loudly, before doing any work, when the settlement program id is unconfigured', async () => {
      const rpc = new FakeRpc();
      const signer = new FakeAttestationSigner();

      await expect(build(rpc, signer, null).propose(PROPOSE_REQUEST)).rejects.toThrow(
        /settlement program/i,
      );
      expect(signer.calls).toHaveLength(0);
      expect(rpc.sent).toHaveLength(0);
    });

    it('fails loudly, with a diagnosable message, when no verifier signing capability is resolvable', async () => {
      const rpc = new FakeRpc();
      const moduleRef = new FakeModuleRef(() => {
        throw new Error('could not resolve VerifierSigningService in the current context');
      });
      const executor = new SolanaSlashExecutor(
        rpc,
        PROGRAM_ADDRESS,
        SOLANA_CHAIN,
        moduleRef as never,
      );

      await expect(executor.propose(PROPOSE_REQUEST)).rejects.toThrow(/verifier signing/i);
      expect(rpc.sent).toHaveLength(0);
    });
  });

  describe('which chain the verifier key is asked for', () => {
    it('names SOLANA_CHAIN_ID on every attestation and every fee-payer signature', async () => {
      // `AttestationSigner` is a STRUCTURAL copy of `VerifierSigningService`'s
      // two methods, and TypeScript's method parameters are bivariant — so the
      // interface kept compiling after `sign` grew a required `chainId`, and
      // every call here would have passed `undefined` into
      // `findActive(chainId)` at runtime. The compiler cannot see it; this can.
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).propose(PROPOSE_REQUEST);

      expect(signer.chainsAsked.length).toBeGreaterThan(0);
      expect(signer.chainsAsked.every((chainId) => chainId === SOLANA_CHAIN)).toBe(true);
      expect(signer.calls.every((call) => call.chainId === SOLANA_CHAIN)).toBe(true);
    });

    it('refuses to sign at all when ENABLED_CHAINS names no single solana chain', async () => {
      // `SOLANA_CHAIN_ID` is null for zero or two Solana chains. Guessing one
      // would pick a verifier key row at random out of two — the mainnet /
      // devnet mislabel `ENABLED_CHAINS` exists to prevent — so the failure is
      // at the call, naming the variable.
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const moduleRef = new FakeModuleRef(() => new FakeAttestationSigner());
      const executor = new SolanaSlashExecutor(rpc, PROGRAM_ADDRESS, null, moduleRef as never);

      await expect(executor.propose(PROPOSE_REQUEST)).rejects.toThrow(/ENABLED_CHAINS/);
      expect(rpc.sent).toHaveLength(0);
    });
  });

  describe('executeProposal (execute_slash)', () => {
    it('submits execute_slash with no attestation and reads what the chain took', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, executedRecord());
      const signer = new FakeAttestationSigner();

      const result = await build(rpc, signer).executeProposal(EXECUTE_REQUEST);

      // The signature was proved at propose time and the record is the
      // evidence, so there is no precompile and nothing is signed but the
      // transaction itself.
      const { message } = decodeSent(rpc);
      expect(message.instructions).toHaveLength(1);
      expect(message.staticAccounts[message.instructions[0].programAddressIndex]).toBe(
        PROGRAM_ADDRESS,
      );
      expect(signer.calls.filter((c) => c.purpose.endsWith('.attestation'))).toHaveLength(0);

      expect(result.appliedMinor).toBe('900');
      expect(result.agentAmountMinor).toBe('540');
      expect(result.platformAmountMinor).toBe('270');
      expect(result.executedAt).toEqual(new Date(1_800_259_300_000));
    });

    it('recovers the fee payer without signing anything to do it', async () => {
      // Every `sign()` writes a signing-journal row, and that journal is the
      // audit record for the verifier key. Reading the key's own address must
      // not put a meaningless entry in it.
      const rpc = new FakeRpc();
      await seedPdas(rpc, executedRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).executeProposal(EXECUTE_REQUEST);

      expect(signer.publicKeyReads).toBeGreaterThan(0);
      // Exactly one journal entry: the transaction signature, and nothing else.
      expect(signer.calls).toHaveLength(1);
      expect(signer.calls[0].purpose).toBe('settlement.execute_slash.transaction');
      expect(signer.calls[0].payload.length).toBeGreaterThan(0);
    });

    it('names the verifier key the record itself points at, not whichever key is signing', async () => {
      // `execute_slash` seeds `verifier_key` from `slash_record.verifier` and
      // meters the judgement against that key's rolling cap. Deriving it from
      // the submitter instead would meter somebody else's budget.
      const rpc = new FakeRpc();
      await seedPdas(rpc, executedRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).executeProposal(EXECUTE_REQUEST);

      const [verifierPda] = await findVerifierKeyPda(
        { verifier: fixedVerifierKeypair().address },
        { programAddress: PROGRAM_ADDRESS },
      );
      const { message } = decodeSent(rpc);
      expect(accountsOf(message, 0)).toContain(verifierPda);
    });

    it('throws rather than resolving when sendTransaction fails', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, executedRecord());
      rpc.failNextSend = 'SlashNotYetExecutable';
      const signer = new FakeAttestationSigner();

      await expect(build(rpc, signer).executeProposal(EXECUTE_REQUEST)).rejects.toThrow(
        'SlashNotYetExecutable',
      );
    });
  });

  describe('buildCancel (cancel_slash) — built, never signed', () => {
    it('compiles an unsigned transaction addressed to Config.admin', async () => {
      // Lean v3's `cancel_slash` takes `Config.admin` as its only signer, and
      // that key is a person's hardware wallet. The whole of what this process
      // can do is compile the transaction; nothing here signs and nothing is
      // submitted.
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      const intent = await build(rpc, signer).buildCancel(CANCEL_REQUEST);

      expect(intent.admin).toBe(ADMIN);
      expect(intent.requestId).toBe(REQUEST_ID);
      expect(intent.provider).toBe(PROVIDER);
      expect(intent.blockhash).toBe(BLOCKHASH);
      // Nothing signed, nothing sent. Both halves matter: a verifier signature
      // on this path would be the mechanism the simplified contract deleted, and a submission
      // would be this platform cancelling on its own say-so.
      expect(signer.calls).toHaveLength(0);
      expect(rpc.sent).toHaveLength(0);
    });

    it('leaves the admin’s signature slot empty, and names the record and the stake', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();

      const intent = await build(rpc, signer).buildCancel(CANCEL_REQUEST);

      const bytes = new Uint8Array(getBase64Encoder().encode(intent.transaction));
      const transaction = getTransactionDecoder().decode(bytes);
      const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
      if (message.version !== 0) throw new Error('expected a v0 compiled message');

      // One instruction, and it is `cancel_slash` — no ed25519 precompile,
      // because there is no attestation to prove any more.
      expect(message.instructions).toHaveLength(1);
      expect(message.staticAccounts[message.instructions[0].programAddressIndex]).toBe(
        PROGRAM_ADDRESS,
      );
      expect(Array.from(message.instructions[0].data ?? []).slice(0, 8)).toEqual(
        Array.from(CANCEL_SLASH_DISCRIMINATOR),
      );

      // The admin is the fee payer and the only signer, and its slot is EMPTY.
      expect(message.staticAccounts[0]).toBe(ADMIN);
      expect(message.header.numSignerAccounts).toBe(1);
      expect(Object.values(transaction.signatures).every((signature) => signature === null)).toBe(
        true,
      );

      // `stake` is seeded from `slash_record.provider` on chain, so Codama
      // cannot resolve it and it has to be passed. Naming the wrong one would
      // leave the reservation held.
      const [stakePda] = await findStakePda(
        { provider: PROVIDER },
        { programAddress: PROGRAM_ADDRESS },
      );
      const accounts = (message.instructions[0].accountIndices ?? []).map(
        (index) => message.staticAccounts[index],
      );
      expect(accounts).toContain(stakePda);
    });

    it('fails loudly, before building anything, when the program id is unconfigured', async () => {
      const rpc = new FakeRpc();
      const signer = new FakeAttestationSigner();

      await expect(build(rpc, signer, null).buildCancel(CANCEL_REQUEST)).rejects.toThrow(
        /settlement program/i,
      );
    });
  });

  describe('expire (expire_slash)', () => {
    it('submits expire_slash with no attestation at all — it is permissionless', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, cancelledRecord());
      const signer = new FakeAttestationSigner();

      const result = await build(rpc, signer).expire(CANCEL_REQUEST);

      const { message } = decodeSent(rpc);
      expect(message.instructions).toHaveLength(1);
      expect(message.staticAccounts[message.instructions[0].programAddressIndex]).toBe(
        PROGRAM_ADDRESS,
      );
      expect(signer.calls.filter((c) => c.purpose.endsWith('.attestation'))).toHaveLength(0);
      expect(signer.calls).toHaveLength(1);
      expect(signer.calls[0].purpose).toBe('settlement.expire_slash.transaction');

      expect(result.cancelledAt).toEqual(new Date(1_800_100_000_000));
    });

    it('carries the stake and verifier key the record points at, and no payer account', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, cancelledRecord());
      const signer = new FakeAttestationSigner();

      await build(rpc, signer).expire(CANCEL_REQUEST);

      const [[stakePda], [verifierPda], [slashRecordPda]] = await Promise.all([
        findStakePda({ provider: PROVIDER }, { programAddress: PROGRAM_ADDRESS }),
        findVerifierKeyPda(
          { verifier: fixedVerifierKeypair().address },
          { programAddress: PROGRAM_ADDRESS },
        ),
        findSlashRecordPda(
          { requestId: Buffer.from(REQUEST_ID, 'hex') },
          { programAddress: PROGRAM_ADDRESS },
        ),
      ]);

      const { message } = decodeSent(rpc);
      const accounts = accountsOf(message, 0);
      // Exactly the three the generated builder declares, in its order.
      expect(accounts).toEqual([slashRecordPda, stakePda, verifierPda]);
    });
  });

  describe('readRecord', () => {
    it('returns null when no record exists, rather than throwing', async () => {
      // The propose sweep asks this before it decides anything. "No record" is
      // a normal answer there and must not be an exception.
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      const signer = new FakeAttestationSigner();

      await expect(build(rpc, signer).readRecord(REQUEST_ID, PROVIDER)).resolves.toBeNull();
    });

    it('maps SlashStatus onto the port’s three names', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, cancelledRecord());
      const signer = new FakeAttestationSigner();

      const snapshot = await build(rpc, signer).readRecord(REQUEST_ID, PROVIDER);

      expect(snapshot!.status).toBe('CANCELLED');
      expect(snapshot!.cancelledAt).toEqual(new Date(1_800_100_000_000));
      expect(snapshot!.executedAt).toBeNull();
    });

    it('reports every amount and clock the recovery paths decide on', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, executedRecord());
      const signer = new FakeAttestationSigner();

      const snapshot = await build(rpc, signer).readRecord(REQUEST_ID, PROVIDER);

      expect(snapshot).toEqual({
        status: 'EXECUTED',
        penaltyMinor: '1000',
        appliedMinor: '900',
        agentAmountMinor: '540',
        platformAmountMinor: '270',
        reservedMinor: '900',
        proposedAt: new Date(1_800_000_000_000),
        executableAt: new Date(1_800_259_200_000),
        executedAt: new Date(1_800_259_300_000),
        cancelledAt: null,
      });
    });

    it('reads the account once, not once to check and once to decode', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, pendingRecord());
      const signer = new FakeAttestationSigner();
      const [slashRecordPda] = await findSlashRecordPda(
        { requestId: Buffer.from(REQUEST_ID, 'hex') },
        { programAddress: PROGRAM_ADDRESS },
      );
      const reads: string[] = [];
      const spy = jest.spyOn(rpc, 'getAccountInfo');
      spy.mockImplementation((account: Address) => {
        reads.push(account);
        return {
          send: async () => {
            const data = rpc.accounts.get(account);
            return { value: data ? { data: [data, 'base64'] as const } : null };
          },
        };
      });

      await build(rpc, signer).readRecord(REQUEST_ID, PROVIDER);

      expect(reads.filter((account) => account === slashRecordPda)).toHaveLength(1);
      spy.mockRestore();
    });
  });

  /**
   * `executeProposal` and `expire` both read the
   * record before they can build anything, so an absent record fails *before*
   * any transaction exists — which means it can never arrive as
   * `CHAIN_TRANSACTION_FAILED`. It needs its own code because it is terminal in
   * a way nothing else on this path is: a `SlashRecord` lives at exactly one
   * PDA per request id, and both doors that end a judgement close the account,
   * so "absent" means over. Classified as transient it would retry forever.
   */
  describe('a judgement with no record on chain', () => {
    it('refuses to execute one, under a code of its own', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .executeProposal(EXECUTE_REQUEST)
        .catch((caught: unknown) => caught);

      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND,
      );
      // Not the transaction failure — that one classifies as retryable when it
      // carries no program code, which is exactly the wrong answer here.
      expect((error as { errorCode?: string }).errorCode).not.toBe(
        ChainErrorCode.CHAIN_TRANSACTION_FAILED,
      );
      expect((error as { context?: Record<string, unknown> }).context?.requestId).toBe(REQUEST_ID);
      expect(rpc.sent).toHaveLength(0);
      expect(signer.calls).toHaveLength(0);
    });

    it('refuses to expire one, under the same code', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .expire(CANCEL_REQUEST)
        .catch((caught: unknown) => caught);

      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_SLASH_RECORD_NOT_FOUND,
      );
      expect(rpc.sent).toHaveLength(0);
    });
  });

  describe('the error a failed transaction throws', () => {
    it('carries the numeric custom-program-error code in a field, not only in the message', async () => {
      // The classifier that decides whether a judgement is void, retryable or
      // still waiting keys on the error's NAME, resolved from this number. A
      // message alone is not parseable: `getAssayPaymentErrorMessage` renders
      // the human sentence, and returns a fixed placeholder in production.
      const rpc = new FakeRpc();
      // No record on chain: a confirmation failure with one present is an
      // adoption, not a throw — see `propose`'s own cases above.
      await seedPdas(rpc, null);
      const signer = new FakeAttestationSigner();
      jest.spyOn(rpc, 'getSignatureStatuses').mockReturnValue({
        send: async () => ({
          value: [
            {
              // 6011 = VerifierRevoked. Named here, never branched on.
              err: { InstructionError: [1, { Custom: 6011 }] },
              confirmationStatus: 'confirmed' as const,
            },
          ],
        }),
      });

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(Error);
      const context = (error as { context?: Record<string, unknown> }).context;
      expect(context?.customErrorCode).toBe(6011);
      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_TRANSACTION_FAILED,
      );
      // The human-readable half is kept too — it is what a log is read for.
      expect((error as Error).message).toContain('6011');
    });

    /**
     * Preflight, not confirmation, is where most named refusals actually land:
     * `skipPreflight` is left at its default, so the node simulates before it
     * accepts. The kit reports that as a `SolanaError` carrying the same
     * `InstructionError` object several levels down, and if the walk misses it
     * every revoked key and unelapsed timelock arrives with a null code — i.e.
     * classified as retryable.
     */
    it('finds the code nested inside a preflight SolanaError', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      rpc.failNextSend = Object.assign(
        new Error('failed to send transaction: Transaction simulation failed'),
        {
          context: {
            __code: 7050004,
            data: {
              // 6046 — named here, never branched on.
              err: { InstructionError: [1, { Custom: 6046 }] },
              logs: ['Program log: AnchorError caused by account: verifier_key'],
            },
          },
        },
      );
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      expect((error as { context?: Record<string, unknown> }).context?.customErrorCode).toBe(6046);
      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_TRANSACTION_FAILED,
      );
    });

    /** The last resort: the number survives only as text. `0x1783` is 6019. */
    it('reads the code back out of a message when it survives nowhere else', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      rpc.failNextSend = 'Transaction failed: custom program error: 0x1783';
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      expect((error as { context?: Record<string, unknown> }).context?.customErrorCode).toBe(6019);
    });

    /**
     * The half that protects the retry policy. A failure the program never saw
     * must not acquire a number — a false code turns a retryable outage into a
     * terminal verdict, and the judgement is dropped.
     */
    it('reports no code at all when the program never spoke', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      rpc.failNextSend = new Error('Blockhash not found');
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      const context = (error as { context?: Record<string, unknown> }).context;
      expect(context?.customErrorCode).toBeNull();
      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_TRANSACTION_FAILED,
      );
    });

    /**
     * The other half of the same guarantee, on the confirmation path: an
     * on-chain failure that is not a `Custom` error carries no number either.
     * The confirmation *timeout* shares this branch — it calls the same wrapper
     * with no cause at all — so both arrive as `null` and classify as
     * retryable, which is what they are.
     */
    it('reports no code for an on-chain failure that is not a program error', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      const signer = new FakeAttestationSigner();
      jest.spyOn(rpc, 'getSignatureStatuses').mockReturnValue({
        send: async () => ({
          value: [
            {
              err: { InstructionError: [1, 'InvalidAccountData'] },
              confirmationStatus: 'confirmed' as const,
            },
          ],
        }),
      });

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      const context = (error as { context?: Record<string, unknown> }).context;
      expect(context?.customErrorCode).toBeNull();
      expect((error as { errorCode?: string }).errorCode).toBe(
        ChainErrorCode.CHAIN_TRANSACTION_FAILED,
      );
    });

    /**
     * The wrapper must not eat the diagnosis. `describeError` keeps only
     * `cause.message`, and for a preflight rejection the `logs` — where every
     * `Program log:` line and the system program's own complaint live — hang off
     * the object. Losing them left an operator with `custom program error: 0x0`
     * and nothing to read.
     */
    it('chains the original rejection so the simulation logs survive', async () => {
      const rpc = new FakeRpc();
      await seedPdas(rpc, null);
      const original = Object.assign(new Error('Transaction simulation failed'), {
        context: { logs: ['Program log: AnchorError occurred. Error Code: SlashNotPending'] },
      });
      rpc.failNextSend = original;
      const signer = new FakeAttestationSigner();

      const error = await build(rpc, signer)
        .propose(PROPOSE_REQUEST)
        .catch((caught: unknown) => caught);

      expect((error as { cause?: unknown }).cause).toBe(original);
      // …and still not on the wire: `toJSON` is the serialised form.
      expect(Object.keys((error as { toJSON(): object }).toJSON())).not.toContain('cause');
    });
  });
});

/** Little-endian `i64` at `offset`, mirroring `attestation-message.ts`'s own encoder. */
function readI64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true);
}
