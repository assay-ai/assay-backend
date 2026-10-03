import { createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';

import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getAddressDecoder,
  getBase58Decoder,
  getBase58Encoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  Instruction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
  findConfigPda,
  findEscrowPda,
  findStakePda,
  getConfigEncoder,
  getRedeemVoucherInstructionAsync,
  voucherMessage,
} from '@x402/settlement-client';

import { FeePayerSignResult } from '@modules/chains/facilitator/signing/fee-payer-signer.port';
import { ASSET_IDS, getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, parseAssetId } from '@modules/chains/ports/caip.types';
import {
  ED25519_PROGRAM_ADDRESS,
  ed25519VerifyInstruction,
} from '@modules/chains/solana/ed25519-precompile';
import {
  SolanaVoucherRedeemer,
  VoucherRedeemerRpcClient,
} from '@modules/chains/solana/voucher-redeemer.service';
import {
  RedeemOutcomeKind,
  RedeemVoucherRequest,
} from '@modules/payment/ports/voucher-redeemer.port';
import {
  SETTLEMENT_ERROR_CODE_BASE,
  SETTLEMENT_ERROR_NAMES,
} from '@modules/slash/domain/chain-slash-outcome';
import { MoneyUtil } from '@shared/utils/money.util';

import { expectSettlementAccountList } from './helpers/instruction-accounts';

/**
 * `SolanaVoucherRedeemer` — the only path in `src/` that may submit
 * `redeem_voucher`.
 *
 * ## The fake sits at the RPC and at the fee payer, never at the port
 *
 * The same trade `settlement-slash-executor.spec.ts` makes: the instruction is
 * built by the real generated builder, the 239 signed bytes are the real
 * `voucherMessage()`, the precompile is the real `Ed25519Program`, and the
 * signature is a real ed25519 signature over those bytes from a locally
 * generated key. Faking `VoucherRedeemerPort` would turn every assertion below
 * into a restatement of the fake, and the thing worth asserting here is a byte
 * count.
 *
 * Nothing here touches a network or a cluster.
 */

const PROGRAM_ADDRESS = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S' as Address;
const BLOCKHASH = '11111111111111111111111111111111';
const USDC = ASSET_IDS.USDC_SOLANA_DEVNET;
const CHAIN_ID = getAssetMetadata(USDC).chainId;
const STAKE_MINT = address(parseAssetId(USDC).assetReference);

/** A legacy transaction's hard limit. Nothing about the batch size is estimated. */
const PACKET_DATA_SIZE = 1232;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keypairFromSeed(seed: number) {
  const pkcs8 = Buffer.concat([
    PKCS8_ED25519_PREFIX,
    Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => (i + seed) % 251)),
  ]);
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

const BUYER = keypairFromSeed(3);
const SECOND_BUYER = keypairFromSeed(77);
const PROVIDER = getAddressDecoder().decode(new Uint8Array(32).fill(9));
const FEE_PAYER = getAddressDecoder().decode(new Uint8Array(32).fill(17));

const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + 300;

function requestFor(
  buyer = BUYER,
  overrides: Partial<RedeemVoucherRequest> = {},
): RedeemVoucherRequest {
  const base = {
    payer: `${CHAIN_ID}:${buyer.address}` as AccountId,
    provider: `${CHAIN_ID}:${PROVIDER}` as AccountId,
    amount: MoneyUtil.of(1_000_000n, USDC, getAssetMetadata(USDC).decimals),
    asset: USDC,
    resourceHash: `sha256:${'ab'.repeat(32)}`,
    requestHash: 'cd'.repeat(32),
    seq: '1',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    signature: '',
    ...overrides,
  } satisfies RedeemVoucherRequest;

  return { ...base, signature: base.signature || signVoucher(buyer, base) };
}

/** A real ed25519 signature over the real 239 bytes. */
function signVoucher(
  buyer: ReturnType<typeof keypairFromSeed>,
  request: Omit<RedeemVoucherRequest, 'signature'>,
): string {
  const bytes = buyer.sign(messageFor(buyer, request));
  return bs58(bytes);
}

function messageFor(
  buyer: ReturnType<typeof keypairFromSeed>,
  request: Omit<RedeemVoucherRequest, 'signature'>,
): Uint8Array {
  return voucherMessage({
    payer: address(buyer.address),
    payTo: escrowOf(buyer),
    provider: address(PROVIDER),
    amount: MoneyUtil.toAtomic(request.amount),
    resourceHash: Buffer.from(request.resourceHash.slice('sha256:'.length), 'hex'),
    requestHash: Buffer.from(request.requestHash, 'hex'),
    seq: BigInt(request.seq),
    issuedAt: BigInt(request.issuedAt),
    expiresAt: BigInt(request.expiresAt),
    programAddress: PROGRAM_ADDRESS,
  });
}

const escrows = new Map<string, Address>();
function escrowOf(buyer: ReturnType<typeof keypairFromSeed>): Address {
  const cached = escrows.get(buyer.address);
  if (!cached) throw new Error('escrow not primed — call primeEscrows() in beforeAll');
  return cached;
}

async function primeEscrows(): Promise<void> {
  for (const buyer of [BUYER, SECOND_BUYER]) {
    const [pda] = await findEscrowPda(
      { buyer: address(buyer.address) },
      { programAddress: PROGRAM_ADDRESS },
    );
    escrows.set(buyer.address, pda);
  }
  [CONFIG_PDA] = await findConfigPda({ programAddress: PROGRAM_ADDRESS });
}

/** `Config`, under the DEPLOYED id — primed alongside the escrows. */
let CONFIG_PDA: Address;

/** `Config.treasury`. Deliberately not the fee payer and not any provider. */
const TREASURY = address('2NNvNBFAMMhCTPFmZgnZBQD8fJvbBLbWfBt9TFYcBBBB');

/** Somebody else's key, for the mismatch case. */
const OTHER_REDEEMER = address('4UUvNBFAMMhCTPFmZgnZBQD8fJvbBLbWfBt9TFYcDDDD');

function encodedConfig(redeemer: Address = address(FEE_PAYER)): string {
  const bytes = getConfigEncoder().encode({
    admin: address('3TTvNBFAMMhCTPFmZgnZBQD8fJvbBLbWfBt9TFYcCCCC'),
    stakeMint: STAKE_MINT,
    treasury: TREASURY,
    unbondingPeriodSeconds: 1_209_600n,
    takeRateBps: 500,
    slashAgentBps: 6_000,
    slashPlatformBps: 3_000,
    slashCapBps: 1_000,
    minimumStake: 100_000_000n,
    penaltyAmount: 1_000_000n,
    verifierDailyCap: 100_000_000n,
    paused: false,
    totalStaked: 0n,
    totalDeposited: 0n,
    totalWithdrawn: 0n,
    totalSlashed: 0n,
    bump: 255,
    vaultBump: 254,
    // `redeem_voucher.rent_payer` carries `address = config.redeemer`, so the
    // default here is the fee payer: a deployment where they differ refuses
    // every redemption, which is its own case below.
    redeemer,
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

function bs58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

/**
 * The three RPC calls this service makes. **No `sendTransaction`** —
 * submission goes through `FeePayerSignerPort`, which is what signs it.
 *
 * `getAccountInfo` serves one account: `Config`, which is where the treasury
 * comes from. Lean v3 pays the platform's fee to `ATA(Config.treasury,
 * stake_mint)`, an account the program requires by address and never derives.
 */
class FakeRpc implements VoucherRedeemerRpcClient {
  statusError: unknown = null;
  confirmationStatus: string | null = 'confirmed';
  /** How many times `Config` was actually fetched — the memo assertion. */
  configReads = 0;
  /** `Config.redeemer`, which the service compares against the fee payer. */
  redeemer: Address = address(FEE_PAYER);
  /** When set, `getAccountInfo` throws instead of answering. */
  configReadFails: unknown = null;

  getAccountInfo(account: Address) {
    return {
      send: async () => {
        if (this.configReadFails !== null) {
          throw this.configReadFails;
        }
        if (account !== CONFIG_PDA) return { value: null };
        this.configReads += 1;
        return { value: { data: [encodedConfig(this.redeemer), 'base64'] as const } };
      },
    };
  }

  getLatestBlockhash() {
    return {
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    };
  }

  getSignatureStatuses() {
    return {
      send: async () => ({
        value: [{ err: this.statusError, confirmationStatus: this.confirmationStatus }],
      }),
    };
  }
}

/** Records every transaction actually submitted, and can refuse one. */
class FakeFeePayerSigner {
  readonly name = 'fake';
  readonly sent: string[] = [];
  failWith: unknown = null;

  async getFeePayerAddress(): Promise<Address> {
    return address(FEE_PAYER);
  }

  async signAndSend(rawTransactionBase64: string): Promise<FeePayerSignResult> {
    if (this.failWith !== null) {
      const failure = this.failWith;
      throw typeof failure === 'string' ? new Error(failure) : failure;
    }
    this.sent.push(rawTransactionBase64);
    return { signature: 'signature-of-the-redemption', signedTransaction: rawTransactionBase64 };
  }

  /** The shape a preflight rejection really has — `{ Custom: n }` several levels down. */
  refuseWithProgramError(code: number): void {
    this.failWith = Object.assign(new Error('Simulation failed'), {
      context: { data: { err: { InstructionError: [1, { Custom: code }] } } },
    });
  }
}

class FakeModuleRef {
  constructor(private readonly resolve: () => unknown) {}
  get(_token: unknown, _options?: unknown): unknown {
    return this.resolve();
  }
}

function harness() {
  const rpc = new FakeRpc();
  const feePayer = new FakeFeePayerSigner();
  const redeemer = new SolanaVoucherRedeemer(
    rpc,
    PROGRAM_ADDRESS,
    new FakeModuleRef(() => feePayer) as never,
  );
  return { redeemer, rpc, feePayer };
}

function decodeSubmitted(wire: string) {
  const transaction = getTransactionDecoder().decode(
    new Uint8Array(getBase64Encoder().encode(wire)),
  );
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error(`expected a v0 compiled message, got version ${String(message.version)}`);
  }
  return message;
}

function byteLength(wire: string): number {
  return Buffer.from(wire, 'base64').length;
}

/**
 * The two instructions one redemption is: the precompile carrying the buyer's
 * signature, then the program call that reads it back out of the instructions
 * sysvar.
 */
async function instructionsFor(
  buyer: ReturnType<typeof keypairFromSeed>,
  request: RedeemVoucherRequest,
): Promise<readonly Instruction[]> {
  const payer = address(buyer.address);
  const provider = address(PROVIDER);
  const [[escrow], [providerStake], [configPda]] = await Promise.all([
    findEscrowPda({ buyer: payer }, { programAddress: PROGRAM_ADDRESS }),
    findStakePda({ provider }, { programAddress: PROGRAM_ADDRESS }),
    findConfigPda({ programAddress: PROGRAM_ADDRESS }),
  ]);
  const [[escrowTokenAccount], [providerTokenAccount], [treasuryTokenAccount]] = await Promise.all([
    findAssociatedTokenPda({
      owner: escrow,
      mint: STAKE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    findAssociatedTokenPda({
      owner: provider,
      mint: STAKE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    findAssociatedTokenPda({
      owner: TREASURY,
      mint: STAKE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
  ]);

  const instruction = await getRedeemVoucherInstructionAsync(
    {
      rentPayer: createNoopSigner(address(FEE_PAYER)),
      config: configPda,
      stakeMint: STAKE_MINT,
      escrow,
      escrowTokenAccount,
      providerStake,
      provider,
      providerTokenAccount,
      treasuryTokenAccount,
      payer,
      payTo: escrow,
      providerArg: provider,
      amount: MoneyUtil.toAtomic(request.amount),
      resourceHash: Buffer.from(request.resourceHash.slice('sha256:'.length), 'hex'),
      requestHash: Buffer.from(request.requestHash, 'hex'),
      seq: BigInt(request.seq),
      issuedAt: BigInt(request.issuedAt),
      expiresAt: BigInt(request.expiresAt),
    },
    { programAddress: PROGRAM_ADDRESS },
  );

  const precompile = ed25519VerifyInstruction(
    buyer.publicKey,
    messageFor(buyer, request),
    Buffer.from(bs58ToBytes(request.signature)),
  );

  return [precompile, instruction];
}

function bs58ToBytes(value: string): Uint8Array {
  return new Uint8Array(getBase58Encoder().encode(value));
}

/** One locally-compiled transaction over `instructions`, as it would go on the wire. */
function compileLocally(instructions: readonly Instruction[]): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(createNoopSigner(address(FEE_PAYER)), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } as Parameters<
          typeof setTransactionMessageLifetimeUsingBlockhash
        >[0],
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

beforeAll(primeEscrows);

describe('SolanaVoucherRedeemer.redeem', () => {
  it('sends exactly one redeem_voucher and one ed25519 precompile, in that order', async () => {
    const { redeemer, feePayer } = harness();

    await redeemer.redeem(requestFor());

    expect(feePayer.sent).toHaveLength(1);
    const message = decodeSubmitted(feePayer.sent[0]);
    expect(message.instructions).toHaveLength(2);
    expect(message.staticAccounts[message.instructions[0].programAddressIndex]).toBe(
      ED25519_PROGRAM_ADDRESS,
    );
    expect(message.staticAccounts[message.instructions[1].programAddressIndex]).toBe(
      PROGRAM_ADDRESS,
    );
  });

  it('fits in a legacy transaction with room to spare, and a second voucher does not', async () => {
    // The simplified contract measured 1,154 of 1,232 bytes for N=1. This suite serialises the
    // real compiled transactions rather than quoting that, so the numbers below
    // are whatever this shape actually costs.
    //
    // Whatever the last two digits are, the conclusion is not close: tens of
    // spare bytes for one, hundreds over for two. Any estimate of "~4-6 per
    // transaction" or ~$0.0001/call rests on a batch that does not exist.
    const { redeemer, feePayer } = harness();

    const one = requestFor();
    await redeemer.redeem(one);

    const submitted = byteLength(feePayer.sent[0]);
    expect(submitted).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(submitted).toBeGreaterThan(1_100);

    // The same instructions, compiled here rather than by the service — proof
    // that the local measurement below is measuring the production shape.
    const sameBuyer = await instructionsFor(BUYER, one);
    expect(byteLength(compileLocally(sameBuyer))).toBe(submitted);

    // Two, for the SAME buyer and provider — the most favourable case there is,
    // because every account key is shared and appears once in the table.
    const second = requestFor(BUYER, { seq: '2', signature: '' });
    const twoSameBuyer = [...sameBuyer, ...(await instructionsFor(BUYER, second))];
    expect(byteLength(compileLocally(twoSameBuyer))).toBeGreaterThan(PACKET_DATA_SIZE);

    // And for different buyers, which is what a real pass would batch.
    const other = requestFor(SECOND_BUYER);
    const twoBuyers = [...sameBuyer, ...(await instructionsFor(SECOND_BUYER, other))];
    expect(byteLength(compileLocally(twoBuyers))).toBeGreaterThan(PACKET_DATA_SIZE);
  });

  it('supplies every account redeem_voucher declares, under the deployed program id', async () => {
    // Thirteen accounts, and `config` is left derivable by the builder — which
    // would have filled it in under the compiled-in `declare_id!()`. That does
    // not show up in a discriminator or a byte count.
    const { redeemer, feePayer } = harness();

    await redeemer.redeem(requestFor());

    await expectSettlementAccountList(feePayer.sent[0], 'redeem_voucher', PROGRAM_ADDRESS);
  });

  it('pays the provider and the treasury directly, at their own associated token accounts', async () => {
    // The whole of what the contract simplification changed about this instruction: there is no
    // earnings pool. `amount − fee` lands in the provider's own ATA and the fee
    // in `ATA(Config.treasury, stake_mint)` — a destination the submitter does
    // not choose, because the program derives it from `Config`.
    const { redeemer, feePayer } = harness();

    await redeemer.redeem(requestFor());

    const message = decodeSubmitted(feePayer.sent[0]);
    const [providerAta] = await findAssociatedTokenPda({
      owner: address(PROVIDER),
      mint: STAKE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [treasuryAta] = await findAssociatedTokenPda({
      owner: TREASURY,
      mint: STAKE_MINT,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    expect(message.staticAccounts).toContain(providerAta);
    expect(message.staticAccounts).toContain(treasuryAta);
  });

  it('reads Config once and remembers the treasury', async () => {
    // `Config.treasury` moves only under an admin `update_config`. Re-reading it
    // per redemption would be one extra RPC round trip on the hot path.
    const { redeemer, rpc } = harness();

    await redeemer.redeem(requestFor());
    await redeemer.redeem(requestFor(BUYER, { seq: '2' }));

    expect(rpc.configReads).toBe(1);
  });

  it('reports the confirmed signature when the redemption lands', async () => {
    const { redeemer } = harness();

    await expect(redeemer.redeem(requestFor())).resolves.toEqual({
      kind: RedeemOutcomeKind.REDEEMED,
      signature: 'signature-of-the-redemption',
      programError: null,
    });
  });

  it('classifies VoucherSeqNotIncreasing as UNREDEEMABLE, by NAME and never by number', async () => {
    // Lean v3 renumbered every code after each variant it removed. The test
    // resolves the number the same way the code does — through the shared name
    // table — so a shift moves both together.
    const { redeemer, feePayer } = harness();
    feePayer.refuseWithProgramError(codeOf('VoucherSeqNotIncreasing'));

    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'VoucherSeqNotIncreasing',
      signature: null,
    });
  });

  it('classifies an empty escrow as RETRY — the buyer may still refill it', async () => {
    const { redeemer, feePayer } = harness();
    feePayer.refuseWithProgramError(codeOf('EscrowInsufficient'));

    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.RETRY,
      programError: 'EscrowInsufficient',
    });
  });

  it('classifies an RPC timeout as RETRY and a paused program as PAUSED', async () => {
    const { redeemer, feePayer } = harness();
    feePayer.failWith = new Error('socket hang up');
    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.RETRY,
      programError: null,
    });

    feePayer.refuseWithProgramError(codeOf('ProgramPaused'));
    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.PAUSED,
      programError: 'ProgramPaused',
    });
  });

  it('refuses the whole pass when Config.redeemer is not this process — before spending a fee', async () => {
    // The finding: redemption stopped being permissionless, so a deployment
    // paying with the wrong key is refused `NotRedeemer` on EVERY hold. Caught
    // off the `Config` read that was already being made for the treasury, so
    // nothing is built and no transaction is submitted.
    const { redeemer, rpc, feePayer } = harness();
    rpc.redeemer = OTHER_REDEEMER;

    await expect(redeemer.redeem(requestFor())).resolves.toEqual({
      kind: RedeemOutcomeKind.MISCONFIGURED,
      signature: null,
      programError: null,
    });
    // Nothing was submitted: not RETRY, so not one wasted preflight per pass.
    expect(feePayer.sent).toHaveLength(0);
  });

  it('classifies NotRedeemer from the chain as MISCONFIGURED, not RETRY and not UNREDEEMABLE', async () => {
    // The redeemer moved under a running process, so its cached `Config`
    // predates the move and the pre-flight check passed. UNREDEEMABLE here
    // would hand every buyer their money back and pay every provider out of
    // platform funds for a fault one `update_config` fixes; RETRY would burn a
    // fee per hold per pass for ever.
    const { redeemer, feePayer } = harness();
    feePayer.refuseWithProgramError(codeOf('NotRedeemer'));

    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.MISCONFIGURED,
      programError: 'NotRedeemer',
      signature: null,
    });
  });

  it('does NOT call an unreadable Config a mismatch — that is a retry, not a page', async () => {
    // An unreachable RPC says nothing about who the redeemer is. Answering
    // MISCONFIGURED to it would stop the pass and page a human for a blip.
    const { redeemer, rpc } = harness();
    rpc.configReadFails = new Error('rpc unreachable');

    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.RETRY,
    });
  });

  it('classifies a refusal that surfaces only at confirmation, not at preflight', async () => {
    const { redeemer, rpc } = harness();
    rpc.statusError = { InstructionError: [1, { Custom: codeOf('MissingBuyerSignature') }] };

    await expect(redeemer.redeem(requestFor())).resolves.toMatchObject({
      kind: RedeemOutcomeKind.UNREDEEMABLE,
      programError: 'MissingBuyerSignature',
      signature: null,
    });
  });

  it('refuses to build anything when no deployed program id is configured', async () => {
    const rpc = new FakeRpc();
    const feePayer = new FakeFeePayerSigner();
    const redeemer = new SolanaVoucherRedeemer(
      rpc,
      null,
      new FakeModuleRef(() => feePayer) as never,
    );

    // Not a RETRY: a missing program id is a deployment fault, and swallowing
    // it as retryable would hammer the same fault once a minute for ever.
    await expect(redeemer.redeem(requestFor())).rejects.toThrow();
    expect(feePayer.sent).toEqual([]);
  });
});

/** The code a name currently carries — resolved, never written down. */
function codeOf(name: string): number {
  const index = SETTLEMENT_ERROR_NAMES.indexOf(name);
  if (index < 0) throw new Error(`${name} is not in SETTLEMENT_ERROR_NAMES`);
  return SETTLEMENT_ERROR_CODE_BASE + index;
}
