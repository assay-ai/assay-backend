import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairFromBytes,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  Instruction,
  InstructionWithAccounts,
  InstructionWithData,
  partiallySignTransaction,
  pipe,
  ReadonlyUint8Array,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { generateKeyPairSync } from 'node:crypto';

import { X402SvmVerifierService } from '@modules/chains/facilitator/verification/x402-svm-verifier.service';
import { DuplicateSettlementGuard } from '@modules/chains/facilitator/verification/duplicate-settlement.guard';
import { FacilitatorSvmRpcClient } from '@modules/chains/facilitator/verification/decode-svm-payload';
import { FeePayerSignerPort } from '@modules/chains/facilitator/signing/fee-payer-signer.port';
import { X402_INVALID_REASON } from '@modules/chains/facilitator/facilitator.wire';
import { PaymentPayload, PaymentRequirements } from '@modules/chains/ports/x402.types';
import { ResolvedSvmInstruction } from '@modules/chains/facilitator/verification/svm-instruction.types';
import {
  FEE_PAYER,
  memoIx,
  OTHER_MINT,
  setComputeUnitLimitIx,
  setComputeUnitPriceIx,
  transferCheckedIx,
  USDC_MINT,
  VAULT_ATA,
} from './helpers/svm-test-fixtures';

const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' as never;

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: SOLANA_DEVNET,
  amount: '10000',
  asset: USDC_MINT,
  payTo: VAULT_ATA,
  resource: 'https://api.platform.io/tools/search_web',
  maxTimeoutSeconds: 60,
};

const requirementsWithMemo: PaymentRequirements = {
  ...requirements,
  extra: { memo: 'pi_01J8XZQ4M0000000000000' },
};

// A real payer key pair — the transaction must carry a genuine signature over
// its own message bytes, or `checkSignatures` rejects it before rule content
// is even inspected.
const payerKeyPair = generateKeyPairSync('ed25519');

function toKitInstruction(ix: ResolvedSvmInstruction) {
  const payer = transferAuthority();
  return {
    programAddress: ix.programAddress,
    accounts: ix.accounts.map((account) => ({
      address: account,
      // The transfer authority must be marked a signer, or the compiled
      // message never allocates it a signature slot to partially-sign into.
      role: account === payer ? AccountRole.READONLY_SIGNER : AccountRole.READONLY,
    })),
    data: ix.data,
  } as Instruction & InstructionWithAccounts<any> & InstructionWithData<ReadonlyUint8Array>;
}

async function buildSignedPayload(
  instructions: readonly ResolvedSvmInstruction[],
): Promise<PaymentPayload> {
  const secretKeyBytes = Buffer.concat([
    payerKeyPair.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(16, 48),
    payerKeyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12),
  ]);
  const payerCryptoKeyPair = await createKeyPairFromBytes(new Uint8Array(secretKeyBytes));

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(FEE_PAYER, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 100n },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions.map(toKitInstruction), m),
  );
  const unsigned = compileTransaction(message);
  const signed = await partiallySignTransaction([payerCryptoKeyPair], unsigned);
  const base64 = getBase64Decoder().decode(getTransactionEncoder().encode(signed));

  return {
    x402Version: 2,
    scheme: 'exact',
    network: SOLANA_DEVNET,
    payload: { transaction: base64 },
  };
}

function emptyRpc(): FacilitatorSvmRpcClient {
  return { getMultipleAccounts: () => ({ send: async () => ({ value: [] }) }) };
}

function fakeSigner(overrides?: Partial<FeePayerSignerPort>): FeePayerSignerPort {
  return {
    name: 'fake',
    getFeePayerAddress: async () => FEE_PAYER,
    signAndSend: async () => ({ signature: 'fakeSignature111', signedTransaction: 'ignored' }),
    ...overrides,
  };
}

function fakeDuplicateGuard(reserves = true): DuplicateSettlementGuard {
  return { reserve: async () => reserves } as unknown as DuplicateSettlementGuard;
}

describe('X402SvmVerifierService — verify', () => {
  it('accepts a well-formed static-path payload and reports the payer', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());

    const result = await service.verify(payload, requirements);

    expect(result.isValid).toBe(true);
    expect(result.invalidReason).toBeUndefined();
  });

  it('rejects a transaction signed by the wrong key — the "bad signature" case', async () => {
    // Build with a genuine signature, decode it back apart, then flip a byte
    // inside the payer's *signature* specifically (not the message) so the
    // transaction still parses but no longer verifies.
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const decoded = getTransactionDecoder().decode(
      getBase64Encoder().encode(payload.payload.transaction as string),
    );
    const payerAddress = transferAuthority();
    const goodSignature = decoded.signatures[payerAddress] as Uint8Array;
    const tamperedSignature = Uint8Array.from(goodSignature);
    tamperedSignature[0] ^= 0xff;
    const tamperedTransaction = {
      ...decoded,
      signatures: { ...decoded.signatures, [payerAddress]: tamperedSignature },
    };
    const badBase64 = getBase64Decoder().decode(
      getTransactionEncoder().encode(tamperedTransaction as never),
    );
    const badPayload: PaymentPayload = { ...payload, payload: { transaction: badBase64 } };

    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());
    const result = await service.verify(badPayload, requirements);

    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_SIGNATURE);
  });

  it('rejects an amount below what was required', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority(), amount: 9_999n }),
    ]);
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());

    const result = await service.verify(payload, requirements);

    expect(result).toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT,
    });
  });

  it('rejects a non-USDC mint', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority(), mint: OTHER_MINT }),
    ]);
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());

    const result = await service.verify(payload, requirements);

    expect(result).toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_ASSET,
    });
  });

  it('rejects a scheme this facilitator does not speak', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());

    const result = await service.verify(payload, { ...requirements, scheme: 'upto' });

    expect(result).toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.UNSUPPORTED_SCHEME,
    });
  });

  it('rejects a transaction whose message fee payer is not our signer', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const service = new X402SvmVerifierService(
      emptyRpc(),
      fakeSigner({ getFeePayerAddress: async () => transferAuthority() }),
      fakeDuplicateGuard(),
    );

    const result = await service.verify(payload, requirements);

    expect(result).toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_FEE_PAYER,
    });
  });

  it('accepts a memo that matches and rejects one that does not', async () => {
    const good = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
      memoIx('pi_01J8XZQ4M0000000000000'),
    ]);
    const bad = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
      memoIx('pi_wrong'),
    ]);
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner(), fakeDuplicateGuard());

    expect((await service.verify(good, requirementsWithMemo)).isValid).toBe(true);
    expect(await service.verify(bad, requirementsWithMemo)).toEqual({
      isValid: false,
      invalidReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_MEMO,
    });
  });
});

describe('X402SvmVerifierService — settle', () => {
  it('signs and broadcasts a valid, not-yet-seen payload', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const signAndSend = jest
      .fn()
      .mockResolvedValue({ signature: 'sig123', signedTransaction: 'x' });
    const service = new X402SvmVerifierService(
      emptyRpc(),
      fakeSigner({ signAndSend }),
      fakeDuplicateGuard(true),
    );

    const result = await service.settle(payload, requirements);

    expect(result.success).toBe(true);
    expect(result.transaction).toBe('sig123');
    expect(result.network).toBe(SOLANA_DEVNET);
    expect(signAndSend).toHaveBeenCalledTimes(1);
  });

  it('refuses a duplicate settlement without ever calling the signer', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority() }),
    ]);
    const signAndSend = jest.fn();
    const service = new X402SvmVerifierService(
      emptyRpc(),
      fakeSigner({ signAndSend }),
      fakeDuplicateGuard(false),
    );

    const result = await service.settle(payload, requirements);

    expect(result).toEqual({
      success: false,
      errorReason: X402_INVALID_REASON.DUPLICATE_SETTLEMENT,
      network: SOLANA_DEVNET,
    });
    expect(signAndSend).not.toHaveBeenCalled();
  });

  it('refuses to settle a payload that fails verification, without reserving or signing', async () => {
    const payload = await buildSignedPayload([
      setComputeUnitLimitIx(),
      setComputeUnitPriceIx(),
      transferCheckedIx({ authority: transferAuthority(), amount: 1n }),
    ]);
    const reserve = jest.fn().mockResolvedValue(true);
    const signAndSend = jest.fn();
    const service = new X402SvmVerifierService(emptyRpc(), fakeSigner({ signAndSend }), {
      reserve,
    } as unknown as DuplicateSettlementGuard);

    const result = await service.settle(payload, requirements);

    expect(result).toEqual({
      success: false,
      errorReason: X402_INVALID_REASON.INVALID_EXACT_SVM_PAYLOAD_AMOUNT,
      network: SOLANA_DEVNET,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(signAndSend).not.toHaveBeenCalled();
  });
});

function transferAuthority() {
  return address(
    getBase58Decoder().decode(
      payerKeyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12),
    ),
  );
}
