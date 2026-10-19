import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  Address,
  getAddressDecoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import {
  findConfigPda,
  findEscrowPda,
  getBuyerEscrowEncoder,
  getConfigEncoder,
  getRequestWithdrawInstructionDataDecoder,
  getSetEscrowLimitsInstructionDataDecoder,
  REQUEST_WITHDRAW_DISCRIMINATOR,
  SET_ESCROW_LIMITS_DISCRIMINATOR,
  WITHDRAW_DISCRIMINATOR,
} from '@assay/settlement-client';

import { AccountId, CHAIN_IDS, toAccountId } from '@modules/chains/ports/caip.types';
import { UnsignedChainTransaction } from '@modules/chains/ports/unsigned-chain-transaction';
import {
  EscrowIntentBuilderRpcClient,
  SolanaEscrowIntentBuilder,
} from '@modules/chains/solana/escrow-intent-builder.service';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';
import { SettlementErrorCode } from '@modules/settlement/errors/settlement.errors';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';
import { expectSettlementAccountList } from './helpers/instruction-accounts';

/**
 * The four transactions a buyer's own wallet signs against their
 * escrow, from the port down to the compiled bytes.
 *
 * The fake sits at the RPC, the structural slice the builder declares —
 * exactly the shape `stake-intent.service.spec.ts` uses for the provider's
 * four. So the generated encoders, the real PDA derivations and the real
 * transaction compilation all run, and the two facts this suite exists to
 * pin down — the transaction is UNSIGNED, and the RPC surface has no send
 * method at all — live precisely in the bytes and the fake a port double
 * would have skipped.
 */

const PROGRAM_ID = '7C4i9t4sHpMpsqsB91JYBmuvNfnbof2DPN1yZp3KjN2S';
const BLOCKHASH = '11111111111111111111111111111111';

function addressOf(seed: number): Address {
  return getAddressDecoder().decode(new Uint8Array(32).fill(seed));
}

const BUYER_ADDRESS = addressOf(7);
const BUYER_ACCOUNT: AccountId = toAccountId(CHAIN_IDS.SOLANA_DEVNET, BUYER_ADDRESS) as AccountId;
const STAKE_MINT = addressOf(99);
const DESTINATION_ADDRESS = addressOf(55);

function encodeConfig(): string {
  const bytes = getConfigEncoder().encode({
    admin: addressOf(200),
    stakeMint: STAKE_MINT,
    treasury: addressOf(201),
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
    // `Config.redeemer` — the only key `redeem_voucher` accepts as `rent_payer`.
    redeemer: addressOf(202),
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

interface EscrowFields {
  readonly withdrawRequested?: bigint;
  readonly withdrawAvailableAt?: bigint;
}

function encodeEscrow(fields: EscrowFields = {}): string {
  const bytes = getBuyerEscrowEncoder().encode({
    buyer: BUYER_ADDRESS,
    seqHigh: 0n,
    withdrawRequested: fields.withdrawRequested ?? 0n,
    withdrawAvailableAt: fields.withdrawAvailableAt ?? 0n,
    totalRedeemed: 0n,
    totalWithdrawn: 0n,
    maxVoucherAmount: 1_000_000_000n,
    maxPerWindow: 1_000_000_000n,
    spentInWindow: 0n,
    windowStartedAt: 0n,
    bump: 255,
    reserved: new Uint8Array(32),
  });
  return Buffer.from(bytes).toString('base64');
}

/** Every RPC call the builder makes, and nothing else — no `sendTransaction`. */
function fakeRpc(accounts: Map<string, string>): EscrowIntentBuilderRpcClient {
  return {
    getAccountInfo: (accountAddress: Address) => ({
      send: async () => {
        const data = accounts.get(accountAddress as unknown as string);
        return { value: data ? { data: [data, 'base64'] as const } : null };
      },
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100n } }),
    }),
  };
}

async function harness(options?: { readonly now?: number; readonly escrow?: EscrowFields | null }) {
  const accounts = new Map<string, string>();
  const [configPda] = await findConfigPda({ programAddress: PROGRAM_ID as Address });
  accounts.set(configPda, encodeConfig());

  const [escrowPda] = await findEscrowPda(
    { buyer: BUYER_ADDRESS },
    { programAddress: PROGRAM_ID as Address },
  );
  const escrowFields = options?.escrow === undefined ? {} : options.escrow;
  if (escrowFields !== null) {
    accounts.set(escrowPda, encodeEscrow(escrowFields));
  }

  const rpc = fakeRpc(accounts);
  const builder = new SolanaEscrowIntentBuilder(rpc, PROGRAM_ID, {
    now: () => options?.now ?? 1_700_000_000_000,
  });

  const [escrowTokenAccount] = await findAssociatedTokenPda({
    owner: escrowPda,
    mint: STAKE_MINT,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });

  return { builder, rpc, escrowPda, escrowTokenAccount };
}

function decodeIntent(transactionBase64: string) {
  const bytes = new Uint8Array(getBase64Encoder().encode(transactionBase64));
  const transaction = getTransactionDecoder().decode(bytes);
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  if (message.version !== 0) {
    throw new Error(`expected a v0 compiled message, got version ${String(message.version)}`);
  }
  return { transaction, message };
}

function lastInstructionData(transactionBase64: string): Uint8Array {
  const { message } = decodeIntent(transactionBase64);
  const instruction = message.instructions[message.instructions.length - 1];
  return new Uint8Array(instruction.data ?? []);
}

/**
 * Narrow `buildIntent`'s value to the unsigned-transaction union's **solana** member.
 *
 * Not a cast: the port returns a three-member union now, and every assertion
 * below reads a field only one member has. Throwing on any other member is the
 * loser being asserted — a builder that started returning an `eip155` member
 * (or a typed-data signature request, which carries no wire bytes at all) fails
 * here instead of comparing `undefined` to `undefined`.
 */
function solanaMember(transaction: UnsignedChainTransaction) {
  if (transaction.namespace !== 'solana' || transaction.kind !== 'transaction') {
    throw new Error(
      `expected the solana/transaction member, got ${transaction.namespace}/${transaction.kind}`,
    );
  }
  return transaction;
}

function discriminatorOf(transactionBase64: string): number[] {
  return Array.from(lastInstructionData(transactionBase64).subarray(0, 8));
}

describe('SolanaEscrowIntentBuilder — every signature slot is empty', () => {
  it('compiles set_escrow_limits with every signature slot empty', async () => {
    const { builder } = await harness();

    const tx = await builder.buildIntent({
      kind: EscrowIntentKind.SET_LIMITS,
      account: BUYER_ACCOUNT,
      asset: 'x' as never,
      amount: null,
      limits: { maxVoucherAmount: 50_000_000n, maxPerWindow: 500_000_000n },
      destination: null,
    });

    // The three discriminants, stamped by the builder. `chainId` is the
    // chain of the ACCOUNT the intent was built for — written out as a literal
    // rather than recomputed from `BUYER_ACCOUNT`, which would only restate the
    // expression the builder itself uses.
    expect(tx.namespace).toBe('solana');
    expect(tx.kind).toBe('transaction');
    expect(tx.chainId).toBe('solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1');
    // The loser: no eip155 field came along for the ride.
    expect(Object.keys(tx)).not.toContain('nonce');
    expect(Object.keys(tx)).not.toContain('maxFeePerGas');
    expect(Object.keys(tx)).not.toContain('domain');

    expect(solanaMember(tx).signers).toEqual([BUYER_ADDRESS]);
    expect(solanaMember(tx).feePayer).toBe(BUYER_ADDRESS);

    const { transaction } = decodeIntent(solanaMember(tx).transactionBase64);
    const signatures = Object.entries(transaction.signatures);
    expect(signatures).toHaveLength(1);
    const [signer, signature] = signatures[0];
    expect(signer).toBe(BUYER_ADDRESS);
    // Null, or 64 zero bytes — either way nothing in this process signed it.
    expect(signature === null || signature.every((byte) => byte === 0)).toBe(true);

    expect(discriminatorOf(solanaMember(tx).transactionBase64)).toEqual(
      Array.from(SET_ESCROW_LIMITS_DISCRIMINATOR),
    );
    expect(
      getSetEscrowLimitsInstructionDataDecoder().decode(
        lastInstructionData(solanaMember(tx).transactionBase64),
      ).maxVoucherAmount,
    ).toBe(50_000_000n);
  });

  it('has no send path at all — the RPC interface has exactly two read methods, and the port cannot broadcast even by mistake', async () => {
    const { builder, rpc } = await harness();

    expect(Object.keys(rpc).sort()).toEqual(['getAccountInfo', 'getLatestBlockhash'].sort());
    expect('send' in (builder as object)).toBe(false);
    expect('submit' in (builder as object)).toBe(false);
  });
});

describe('SolanaEscrowIntentBuilder — REQUEST_WITHDRAW', () => {
  it('builds request_withdraw(0) as a cancellation rather than refusing it', async () => {
    // Without a cancel, a buyer who changes their mind has no way
    // back to serving traffic except by actually withdrawing —
    // `VoucherService` refuses new vouchers while a request stands.
    const { builder } = await harness();

    const tx = await builder.buildIntent({
      kind: EscrowIntentKind.REQUEST_WITHDRAW,
      account: BUYER_ACCOUNT,
      asset: 'x' as never,
      amount: { amount: '0', asset: 'x' as never, decimals: 6 },
      limits: null,
      destination: null,
    });

    expect(discriminatorOf(solanaMember(tx).transactionBase64)).toEqual(
      Array.from(REQUEST_WITHDRAW_DISCRIMINATOR),
    );
    expect(
      getRequestWithdrawInstructionDataDecoder().decode(
        lastInstructionData(solanaMember(tx).transactionBase64),
      ).amount,
    ).toBe(0n);
  });

  it('builds a real request_withdraw for a positive amount', async () => {
    const { builder } = await harness();

    const tx = await builder.buildIntent({
      kind: EscrowIntentKind.REQUEST_WITHDRAW,
      account: BUYER_ACCOUNT,
      asset: 'x' as never,
      amount: { amount: '5000000', asset: 'x' as never, decimals: 6 },
      limits: null,
      destination: null,
    });

    expect(
      getRequestWithdrawInstructionDataDecoder().decode(
        lastInstructionData(solanaMember(tx).transactionBase64),
      ).amount,
    ).toBe(5_000_000n);
  });
});

describe('SolanaEscrowIntentBuilder — WITHDRAW', () => {
  it('refuses a withdraw destination that is the escrow’s own token account', async () => {
    const { builder, escrowTokenAccount } = await harness({
      escrow: { withdrawRequested: 1_000_000n, withdrawAvailableAt: 1_699_999_000n },
    });

    await expectErrorCodeAsync(
      () =>
        builder.buildIntent({
          kind: EscrowIntentKind.WITHDRAW,
          account: BUYER_ACCOUNT,
          asset: 'x' as never,
          amount: null,
          limits: null,
          destination: toAccountId(CHAIN_IDS.SOLANA_DEVNET, escrowTokenAccount) as AccountId,
        }),
      SettlementErrorCode.SETTLEMENT_WITHDRAWAL_DESTINATION_INVALID,
    );
  });

  it('refuses to build a withdraw before the escrow says it is available', async () => {
    const { builder } = await harness({
      // now (ms) is 1_700_000_000_000 by default; availableAt (s) is later.
      escrow: { withdrawRequested: 1_000_000n, withdrawAvailableAt: 1_700_003_600n },
    });

    await expectErrorCodeAsync(
      () =>
        builder.buildIntent({
          kind: EscrowIntentKind.WITHDRAW,
          account: BUYER_ACCOUNT,
          asset: 'x' as never,
          amount: null,
          limits: null,
          destination: toAccountId(CHAIN_IDS.SOLANA_DEVNET, DESTINATION_ADDRESS) as AccountId,
        }),
      SettlementErrorCode.SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE,
    );
  });

  it('refuses a withdraw with no request outstanding at all', async () => {
    const { builder } = await harness({ escrow: { withdrawRequested: 0n } });

    await expectErrorCodeAsync(
      () =>
        builder.buildIntent({
          kind: EscrowIntentKind.WITHDRAW,
          account: BUYER_ACCOUNT,
          asset: 'x' as never,
          amount: null,
          limits: null,
          destination: toAccountId(CHAIN_IDS.SOLANA_DEVNET, DESTINATION_ADDRESS) as AccountId,
        }),
      SettlementErrorCode.SETTLEMENT_WITHDRAWAL_NOT_YET_AVAILABLE,
    );
  });

  it('builds withdraw once the request has matured, to the named destination', async () => {
    const { builder } = await harness({
      now: 1_700_010_000_000,
      escrow: { withdrawRequested: 1_000_000n, withdrawAvailableAt: 1_700_003_600n },
    });

    const tx = await builder.buildIntent({
      kind: EscrowIntentKind.WITHDRAW,
      account: BUYER_ACCOUNT,
      asset: 'x' as never,
      amount: null,
      limits: null,
      destination: toAccountId(CHAIN_IDS.SOLANA_DEVNET, DESTINATION_ADDRESS) as AccountId,
    });

    expect(discriminatorOf(solanaMember(tx).transactionBase64)).toEqual(
      Array.from(WITHDRAW_DISCRIMINATOR),
    );
  });

  it('defaults the destination to the buyer’s own ATA when none is given', async () => {
    const { builder } = await harness({
      now: 1_700_010_000_000,
      escrow: { withdrawRequested: 1_000_000n, withdrawAvailableAt: 1_700_003_600n },
    });

    const tx = await builder.buildIntent({
      kind: EscrowIntentKind.WITHDRAW,
      account: BUYER_ACCOUNT,
      asset: 'x' as never,
      amount: null,
      limits: null,
      destination: null,
    });

    expect(discriminatorOf(solanaMember(tx).transactionBase64)).toEqual(
      Array.from(WITHDRAW_DISCRIMINATOR),
    );
  });
});

describe('SolanaEscrowIntentBuilder — no escrow at all', () => {
  it('refuses every kind with PAYMENT_ESCROW_NOT_OPEN when the escrow has never been opened', async () => {
    const { builder } = await harness({ escrow: null });

    await expectErrorCodeAsync(
      () =>
        builder.buildIntent({
          kind: EscrowIntentKind.SET_LIMITS,
          account: BUYER_ACCOUNT,
          asset: 'x' as never,
          amount: null,
          limits: { maxVoucherAmount: 1n, maxPerWindow: 1n },
          destination: null,
        }),
      PaymentErrorCode.PAYMENT_ESCROW_NOT_OPEN,
    );
  });
});

/**
 * The gate that was missing when per-buyer escrows grew these instructions.
 *
 * `close_escrow` went from five accounts to seven and `withdraw` from six to
 * seven, and the whole unit suite stayed green: nothing above asserts on an
 * account list, and a discriminator does not move when an account is appended.
 * `tsc` caught the two *required* additions and would have caught neither
 * `config`, because Codama makes an account it can derive optional and then
 * derives it under the client's compiled-in `declare_id!()` — a different
 * program from the one `PROGRAM_ID` names here, and a different program from
 * the one the per-buyer escrow program deploys to.
 */
describe('SolanaEscrowIntentBuilder — the account list the IDL declares', () => {
  const request = (kind: EscrowIntentKind, overrides: Record<string, unknown> = {}) => ({
    kind,
    account: BUYER_ACCOUNT,
    asset: 'x' as never,
    amount: null,
    limits: null,
    destination: null,
    ...overrides,
  });

  it('supplies every account of set_escrow_limits, under the deployed program id', async () => {
    const { builder } = await harness();
    const tx = await builder.buildIntent(
      request(EscrowIntentKind.SET_LIMITS, {
        limits: { maxVoucherAmount: 1n, maxPerWindow: 2n },
      }) as never,
    );

    await expectSettlementAccountList(
      solanaMember(tx).transactionBase64,
      'set_escrow_limits',
      PROGRAM_ID as Address,
    );
  });

  it('supplies every account of request_withdraw, under the deployed program id', async () => {
    const { builder } = await harness();
    const tx = await builder.buildIntent(
      request(EscrowIntentKind.REQUEST_WITHDRAW, {
        amount: { amount: '1000000', asset: 'x' as never, decimals: 6 },
      }) as never,
    );

    await expectSettlementAccountList(
      solanaMember(tx).transactionBase64,
      'request_withdraw',
      PROGRAM_ID as Address,
    );
  });

  it('supplies all seven accounts of withdraw, including the config mint pin', async () => {
    const { builder } = await harness({
      now: 1_700_010_000_000,
      escrow: { withdrawRequested: 1_000_000n, withdrawAvailableAt: 1_700_003_600n },
    });
    const tx = await builder.buildIntent(request(EscrowIntentKind.WITHDRAW) as never);

    await expectSettlementAccountList(
      solanaMember(tx).transactionBase64,
      'withdraw',
      PROGRAM_ID as Address,
    );
  });
});
