import { NamespaceVoucherRedeemer } from '@modules/chains/multiplex/namespace-voucher-redeemer';
import { CHAIN_IDS, ChainNamespace } from '@modules/chains/ports/caip.types';
import { RedeemVoucherRequest } from '@modules/payment/ports/voucher-redeemer.port';

/**
 * The optional live reads `VoucherRedemptionService` asks reach the payer's
 * chain through the multiplexer (review 2026-10-24 wave 2 M-2): a door the
 * multiplexer does not forward is a door the service never sees.
 */
describe('NamespaceVoucherRedeemer — optional doors', () => {
  const evmRequest = {
    payer: `${CHAIN_IDS.ROBINHOOD_TESTNET}:0x0000000000000000000000000000000000000001`,
  } as RedeemVoucherRequest;
  const solanaRequest = {
    payer: `${CHAIN_IDS.SOLANA_DEVNET}:9B2yKCsMTQNbMjJU3wvwhKxjvtpA6TmmbeLtPV4Totpo`,
  } as RedeemVoucherRequest;

  const evm = {
    maxBatchSize: 64,
    redeem: jest.fn(),
    redeemBatch: jest.fn(),
    providerBelowMinimumStake: jest.fn(async () => true),
    providerShortOnlyByUnplannedSlashes: jest.fn(async () => true),
    usedSeqRecord: jest.fn(async () => 'HELD' as const),
  };
  const solana = { maxBatchSize: 1, redeem: jest.fn(), redeemBatch: jest.fn() };
  const redeemer = new NamespaceVoucherRedeemer(
    new Map([
      [ChainNamespace.EIP155, evm as never],
      [ChainNamespace.SOLANA, solana as never],
    ]),
  );

  it('forwards each to the payer’s chain', async () => {
    await expect(redeemer.providerBelowMinimumStake(evmRequest)).resolves.toBe(true);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(evmRequest)).resolves.toBe(true);
    await expect(redeemer.usedSeqRecord(evmRequest)).resolves.toBe('HELD');
  });

  it('answers "not asked" on a chain whose redeemer has no such door', async () => {
    await expect(redeemer.providerBelowMinimumStake(solanaRequest)).resolves.toBe(false);
    await expect(redeemer.providerShortOnlyByUnplannedSlashes(solanaRequest)).resolves.toBe(false);
    await expect(redeemer.usedSeqRecord(solanaRequest)).rejects.toBeDefined();
  });
});
