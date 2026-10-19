import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { PaymentRequirements } from '@modules/chains/ports/x402.types';
import { SolanaDepositRequirementsBuilder } from '@modules/chains/solana/deposit-requirements-builder.service';
import { BlockhashReaderPort } from '@modules/chains/solana/blockhash.port';
import { PaymentErrorCode } from '@modules/payment/errors/payment.errors';

import { expectErrorCodeAsync } from '../../helpers/expect-error-code';

const DEPOSIT_ID = '33333333-3333-3333-3333-333333333333';
const ESCROW_ATA = 'BuyerEscrowAta11111111111111111111111111111';
const MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const FEE_PAYER = 'FacilitatorFeePayer1111111111111111111111111';

function requirements(extra?: Record<string, unknown>): PaymentRequirements {
  return {
    scheme: 'exact',
    network: CHAIN_IDS.SOLANA_DEVNET,
    amount: '5000000',
    asset: MINT,
    payTo: ESCROW_ATA,
    resource: `assay:deposit:${DEPOSIT_ID}`,
    maxTimeoutSeconds: 60,
    description: 'Deposit to platform balance',
    extra: extra ?? { feePayer: FEE_PAYER, memo: DEPOSIT_ID },
  };
}

function build(blockhash?: Partial<{ blockhash: string; lastValidBlockHeight: bigint }>) {
  const reader = {
    getLatestBlockhash: jest.fn().mockResolvedValue({
      blockhash: 'Blockhash111111111111111111111111111111111',
      lastValidBlockHeight: 312_445_678n,
      ...blockhash,
    }),
  };
  return {
    reader,
    builder: new SolanaDepositRequirementsBuilder(reader as unknown as BlockhashReaderPort),
  };
}

describe('SolanaDepositRequirementsBuilder', () => {
  it('assembles the whole response body, discriminated on namespace', async () => {
    const { builder } = build();

    const result = await builder.build({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      requirements: requirements(),
      decimals: 6,
    });

    expect(result).toEqual({
      namespace: 'solana',
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      payTo: ESCROW_ATA,
      asset: MINT,
      amount: '5000000',
      decimals: 6,
      feePayer: FEE_PAYER,
      memo: DEPOSIT_ID,
      blockhash: 'Blockhash111111111111111111111111111111111',
      // A literal, not `reading.lastValidBlockHeight.toString()`: an
      // expectation derived from the same expression the code uses is
      // indistinguishable from a hardcoded value that happens to match.
      lastValidBlockHeight: '312445678',
    });
  });

  it('reads the blockhash exactly once', async () => {
    // The intent lives 120 seconds and `settleDeposit` rebuilds the x402
    // requirements a SECOND time. A blockhash re-read on that path would
    // differ from the one the buyer signed against — silently, and only for
    // the transactions slow enough for it to matter.
    const { builder, reader } = build();

    await builder.build({
      chainId: CHAIN_IDS.SOLANA_DEVNET,
      requirements: requirements(),
      decimals: 6,
    });

    expect(reader.getLatestBlockhash).toHaveBeenCalledTimes(1);
  });

  it('refuses a facilitator that advertised no fee payer', async () => {
    const { builder } = build();

    await expectErrorCodeAsync(
      () =>
        builder.build({
          chainId: CHAIN_IDS.SOLANA_DEVNET,
          requirements: requirements({ memo: DEPOSIT_ID }),
          decimals: 6,
        }),
      PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    );
  });

  it('refuses a non-string extra.feePayer rather than casting it', async () => {
    // Carried over from `deposits.controller.spec.ts`, which asserted this
    // before the assembly moved here. A cast would put the string "12345" —
    // or worse, "[object Object]" — into a 402 the browser signs against.
    const { builder } = build();

    await expectErrorCodeAsync(
      () =>
        builder.build({
          chainId: CHAIN_IDS.SOLANA_DEVNET,
          requirements: requirements({ feePayer: 12345, memo: DEPOSIT_ID }),
          decimals: 6,
        }),
      PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    );
  });

  it('refuses requirements carrying no extra at all', async () => {
    // Also carried over: `extra` is optional on `PaymentRequirements`, so the
    // absent-object case is a different branch from the absent-field one.
    const { builder } = build();

    await expectErrorCodeAsync(
      () =>
        builder.build({
          chainId: CHAIN_IDS.SOLANA_DEVNET,
          requirements: { ...requirements(), extra: undefined },
          decimals: 6,
        }),
      PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    );
  });

  it('refuses a facilitator that advertised no memo', async () => {
    // The memo IS the deposit id, and the adapter binds the payload to the
    // intent through it. A cast would ship the string "undefined" into a 402.
    const { builder } = build();

    await expectErrorCodeAsync(
      () =>
        builder.build({
          chainId: CHAIN_IDS.SOLANA_DEVNET,
          requirements: requirements({ feePayer: FEE_PAYER }),
          decimals: 6,
        }),
      PaymentErrorCode.PAYMENT_DEPOSIT_REQUIREMENTS_INCOMPLETE,
    );
  });
});
