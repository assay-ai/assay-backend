import { generateKeyPairSync, sign } from 'node:crypto';

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { ASSAY_PAYMENT_PROGRAM_ADDRESS } from '@assay/settlement-client';

import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { computeResourceHash, hashHexToBytes } from '@modules/payment/domain/resource-hash';
import {
  AccountId,
  AssetId,
  CHAIN_IDS,
  ChainId,
  ChainNamespace,
} from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { PaymentIntent, SettlementReceipt, Voucher } from '@modules/chains/ports/x402.types';
import {
  MEMO_PROGRAM_ADDRESS,
  PAYOUT_PROOF_MESSAGE_VERSION,
} from '@modules/chains/solana/solana.constants';
import { SolanaChainAdapter, SolanaRpcClient } from '@modules/chains/solana/solana-chain.adapter';
import { MoneyUtil } from '@shared/utils/money.util';
import { expectErrorCode, expectErrorCodeAsync } from '../helpers/expect-error-code';

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC = `${SOLANA_MAINNET}/token:${USDC_MINT}` as AssetId;
const PAYER_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const VAULT_OWNER = `${SOLANA_MAINNET}:${PAYER_ADDRESS}` as AccountId;
/** ATA of `PAYER_ADDRESS` for the USDC mint under the SPL Token program. */
const VAULT_ATA = 'C4PRXFV6Gf5mytVZb6RoeLsG8CjcFWzR2EJ3dvwPTUJH';
const FACILITATOR = `${SOLANA_MAINNET}:H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp` as AccountId;
const PROVIDER_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const PROVIDER = `${SOLANA_MAINNET}:${PROVIDER_ADDRESS}` as AccountId;

/**
 * The address the settlement program is **deployed** to, which is not the
 * address it was **built** for.
 *
 * Deliberately different from `ASSAY_PAYMENT_PROGRAM_ADDRESS` — the client's
 * compiled-in `declare_id!()` — because the voucher signs the program id at
 * offset 16 and a redeploy can move it to a new one. A default to the compiled-in
 * constant would have every buyer sign bytes naming a program that is not the
 * one about to check them: the call is served, the money is held, and every
 * redemption dies with `MissingBuyerSignature`.
 */
const DEPLOYED_PROGRAM_ID = 'PR5bEscrowRedep1oyment11111111111111111111z';

const usdc = (amount: string) => MoneyUtil.of(amount, USDC, 6);

function buildTransactionWithMemos(memos: readonly string[]): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(PAYER_ADDRESS), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: '11111111111111111111111111111111' as never, lastValidBlockHeight: 100n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstructions(
        memos.map((memo) => ({
          programAddress: address(MEMO_PROGRAM_ADDRESS),
          accounts: [],
          data: new TextEncoder().encode(memo),
        })),
        m,
      ),
  );
  return getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function stubRpc(amount: string, decimals: number): SolanaRpcClient {
  return {
    getTokenAccountBalance: () => ({
      send: async () => ({ value: { amount, decimals } }),
    }),
    getTransaction: () => ({
      send: async () => null,
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: 'Hash11111', lastValidBlockHeight: 123n },
      }),
    }),
  } as SolanaRpcClient;
}

const intent: PaymentIntent = {
  id: 'pi_01J8XZQ4M0000000000000',
  resource: 'https://api.platform.io/tools/search_web',
  amount: usdc('10000'),
  payTo: VAULT_OWNER,
  // Unread on Solana — the escrow PDA is both owner and balance. Deliberately
  // NOT `VAULT_OWNER`, so an adapter that read `payer` here would fail.
  payer: PROVIDER,
  chainId: SOLANA_MAINNET,
  expiresAt: new Date('2026-08-13T00:01:00.000Z'),
};

let adapter: SolanaChainAdapter;

beforeEach(() => {
  adapter = new SolanaChainAdapter(
    stubRpc('10000', 6),
    [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
    DEPLOYED_PROGRAM_ID,
  );
});

describe('SolanaChainAdapter — identity', () => {
  it('declares its namespace and the chains it serves', () => {
    expect(adapter.namespace).toBe(ChainNamespace.SOLANA);
    expect(adapter.supportedChains).toEqual([CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET]);
  });

  it('serves only its own namespace out of the deployment-wide ENABLED_CHAINS', () => {
    // `ENABLED_CHAINS` is one list for the whole deployment and may name
    // `eip155:*` once an EVM adapter exists. Keeping those here would make
    // `ChainAdapterRegistry.resolve()` hand an EVM chain id to this adapter,
    // which cannot talk to it — and `enabledChains()`, which the reconciler and
    // the payout batch walk, would list it as served.
    const scoped = new SolanaChainAdapter(stubRpc('10000', 6), [
      CHAIN_IDS.SOLANA_DEVNET,
      CHAIN_IDS.BASE_MAINNET,
    ]);

    expect(scoped.supportedChains).toEqual([CHAIN_IDS.SOLANA_DEVNET]);
    expectErrorCode(
      () => scoped.isValidAddress(CHAIN_IDS.SOLANA_MAINNET, PAYER_ADDRESS),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('accepts a base58 32-byte address', () => {
    expect(adapter.isValidAddress(SOLANA_MAINNET, PAYER_ADDRESS)).toBe(true);
  });

  it.each([
    ['an EVM address', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'],
    ['a truncated address', '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJos'],
    ['base58-illegal characters', '0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl'],
    ['the empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(adapter.isValidAddress(SOLANA_MAINNET, value)).toBe(false);
  });

  it('refuses a chain it does not serve rather than guessing', () => {
    expectErrorCode(
      () => adapter.isValidAddress(CHAIN_IDS.BASE_MAINNET, PAYER_ADDRESS),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('round-trips an account id', () => {
    const accountId = adapter.toAccountId(SOLANA_MAINNET, PAYER_ADDRESS);
    expect(accountId).toBe(VAULT_OWNER);
    expect(adapter.parseAccountId(accountId)).toEqual({
      chainId: SOLANA_MAINNET,
      address: PAYER_ADDRESS,
    });
  });

  it('refuses to mint an account id from an address of another namespace', () => {
    expectErrorCode(
      () => adapter.toAccountId(SOLANA_MAINNET, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
      ChainErrorCode.CHAIN_INVALID_ADDRESS,
    );
  });
});

describe('SolanaChainAdapter — x402 requirements', () => {
  it('advertises an exact-scheme entry paying the vault ATA, bound by memo', async () => {
    const requirements = await adapter.buildPaymentRequirements({
      chainId: SOLANA_MAINNET,
      intentId: intent.id,
      resource: intent.resource,
      amount: intent.amount,
      payTo: VAULT_OWNER,
      payer: VAULT_OWNER,
      feePayer: FACILITATOR,
    });

    expect(requirements).toEqual({
      scheme: 'exact',
      network: SOLANA_MAINNET,
      amount: '10000',
      asset: USDC_MINT,
      payTo: VAULT_ATA,
      resource: intent.resource,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: 'upfront',
        feePayer: 'H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp',
        memo: intent.id,
      },
    });
  });

  it('refuses to build requirements on a chain it does not serve', async () => {
    await expectErrorCodeAsync(
      () =>
        adapter.buildPaymentRequirements({
          chainId: CHAIN_IDS.BASE_MAINNET,
          intentId: intent.id,
          resource: intent.resource,
          amount: intent.amount,
          payTo: VAULT_OWNER,
          payer: VAULT_OWNER,
          feePayer: FACILITATOR,
        }),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('refuses to advertise an asset that lives on another chain', async () => {
    await expectErrorCodeAsync(
      () =>
        adapter.buildPaymentRequirements({
          chainId: SOLANA_MAINNET,
          intentId: intent.id,
          resource: intent.resource,
          amount: MoneyUtil.of('10000', `${CHAIN_IDS.BASE_MAINNET}/erc20:0x8335` as AssetId, 6),
          payTo: VAULT_OWNER,
          payer: VAULT_OWNER,
          feePayer: FACILITATOR,
        }),
      ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN,
    );
  });
});

describe('SolanaChainAdapter — payload is bound to its intent', () => {
  const payloadFor = (memos: readonly string[]) => ({
    x402Version: 2,
    scheme: 'exact',
    network: SOLANA_MAINNET,
    payload: { transaction: buildTransactionWithMemos(memos) },
  });

  it('accepts a transaction whose memo is the intent id', () => {
    expect(() => adapter.assertPayloadBoundToIntent(payloadFor([intent.id]), intent)).not.toThrow();
  });

  it('rejects a transaction memo-bound to a different intent', () => {
    expectErrorCode(
      () => adapter.assertPayloadBoundToIntent(payloadFor(['pi_someone_elses_intent']), intent),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('rejects a transaction carrying no memo at all', () => {
    expectErrorCode(
      () => adapter.assertPayloadBoundToIntent(payloadFor([]), intent),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('rejects a transaction that smuggles a second memo alongside the right one', () => {
    expectErrorCode(
      () => adapter.assertPayloadBoundToIntent(payloadFor([intent.id, 'pi_other']), intent),
      ChainErrorCode.CHAIN_PAYLOAD_NOT_BOUND_TO_INTENT,
    );
  });

  it('rejects a payload advertised for another network', () => {
    expectErrorCode(
      () =>
        adapter.assertPayloadBoundToIntent(
          { ...payloadFor([intent.id]), network: CHAIN_IDS.BASE_MAINNET },
          intent,
        ),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('rejects an undecodable transaction rather than treating it as unbound-but-fine', () => {
    expectErrorCode(
      () =>
        adapter.assertPayloadBoundToIntent(
          {
            x402Version: 2,
            scheme: 'exact',
            network: SOLANA_MAINNET,
            payload: { transaction: '!!' },
          },
          intent,
        ),
      ChainErrorCode.CHAIN_PAYLOAD_MALFORMED,
    );
  });
});

describe('SolanaChainAdapter — settled amount tolerates overpayment', () => {
  const receipt = (amount: string, asset: AssetId = USDC): SettlementReceipt => ({
    transaction: '5j7s...' as never,
    network: SOLANA_MAINNET,
    payer: VAULT_OWNER,
    observed: { amount, asset, decimals: 6 },
  });

  it('credits the observed amount, not the requested one, when the payer overpays', () => {
    expect(adapter.extractSettledAmount(intent, receipt('10001'))).toEqual(usdc('10001'));
  });

  it('credits the exact amount when it matches', () => {
    expect(adapter.extractSettledAmount(intent, receipt('10000'))).toEqual(usdc('10000'));
  });

  it('rejects an underpayment', () => {
    expectErrorCode(
      () => adapter.extractSettledAmount(intent, receipt('9999')),
      ChainErrorCode.CHAIN_SETTLED_AMOUNT_BELOW_INTENT,
    );
  });

  it('rejects a settlement in a different asset', () => {
    expectErrorCode(
      () =>
        adapter.extractSettledAmount(
          intent,
          receipt(
            '10000',
            `${SOLANA_MAINNET}/token:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` as AssetId,
          ),
        ),
      ChainErrorCode.CHAIN_SETTLED_ASSET_MISMATCH,
    );
  });
});

describe('SolanaChainAdapter — extractSettledAmount refuses a receipt from the wrong chain', () => {
  /**
   * The intent is on **devnet**, which this adapter serves, and so is its
   * receipt.
   *
   * Deliberately not the mainnet fixture the block above uses. A guard written
   * as `receipt.network !== SOLANA_MAINNET` — a constant rather than the
   * intent's own chain — passes a mainnet-intent/devnet-receipt pair and passes
   * a mainnet control, so it would satisfy both halves of this block. Anchoring
   * the pair on the *other* served chain is what makes the control refuse it.
   */
  const settledIntent: PaymentIntent = { ...intent, chainId: CHAIN_IDS.SOLANA_DEVNET };

  const receipt = (network: ChainId): SettlementReceipt => ({
    transaction: '5j7s...' as never,
    network,
    payer: VAULT_OWNER,
    observed: { amount: '10000', asset: USDC, decimals: 6 },
  });

  it('refuses an intent on a chain this adapter does not serve', () => {
    // Unreachable while one chain is enabled; live the day the second is.
    // The intent carries a chainId and the method never looked at it.
    //
    // Intent AND receipt name the same unserved chain, so the only thing wrong
    // with this pair is that the adapter does not serve it — a receipt left on
    // devnet would also trip the network comparison below and the case would
    // pass for either reason.
    expectErrorCode(
      () =>
        adapter.extractSettledAmount(
          { ...settledIntent, chainId: CHAIN_IDS.ROBINHOOD_TESTNET },
          receipt(CHAIN_IDS.ROBINHOOD_TESTNET),
        ),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });

  it('refuses a receipt whose network is not the intent chain', () => {
    // The sharper half. A receipt from chain B settling an intent on chain A
    // has been possible all along; the only thing keeping them aligned is
    // that `deposit.service.ts` passes `network: intent.chainId` literally,
    // which is a property of ONE call site and not of the port.
    //
    // Both chains are SERVED, so this is a genuine cross-chain mismatch rather
    // than an unserved chain wearing a second hat.
    expectErrorCode(
      () => adapter.extractSettledAmount(settledIntent, receipt(CHAIN_IDS.SOLANA_MAINNET)),
      ChainErrorCode.CHAIN_SETTLED_NETWORK_MISMATCH,
    );
  });

  it('still settles a receipt on the intent chain', () => {
    // The control. Both guards are satisfiable by `throw` alone without it.
    expect(adapter.extractSettledAmount(settledIntent, receipt(CHAIN_IDS.SOLANA_DEVNET))).toEqual(
      usdc('10000'),
    );
  });
});

describe('SolanaChainAdapter — voucher v2', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const signerAddress = getBase58Decoder().decode(rawPublicKey);
  const signer = `${SOLANA_MAINNET}:${signerAddress}` as AccountId;

  const voucher: Voucher = {
    payer: signer,
    payTo: VAULT_OWNER,
    provider: PROVIDER,
    amount: usdc('10000'),
    resource: intent.resource,
    requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
    seq: '42',
    issuedAt: 1_785_999_800,
    expiresAt: 1_786_000_000,
  };

  const signVoucher = (v: Voucher) =>
    getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildVoucherMessage(v)), keyPair.privateKey),
    );

  const addressBytes = (value: string) => Array.from(getAddressEncoder().encode(address(value)));

  it('builds the 240 bytes the settlement program recomputes', () => {
    const message = adapter.buildVoucherMessage(voucher);

    expect(message).toHaveLength(240);
    expect(new TextDecoder().decode(message.subarray(0, 16))).toBe('assay:voucher:v2');
  });

  it('signs over the DEPLOYED program id, not the one compiled into the client', () => {
    // The program id is at offset 16..48 of the signed bytes. A redeploy can
    // land under a new id, so a default would have every buyer sign for a program
    // that is not the one about to check the signature.
    const message = adapter.buildVoucherMessage(voucher);

    expect(Array.from(message.subarray(16, 48))).toEqual(addressBytes(DEPLOYED_PROGRAM_ID));
    expect(DEPLOYED_PROGRAM_ID).not.toBe(ASSAY_PAYMENT_PROGRAM_ADDRESS);
  });

  it('refuses to build a voucher message when the program id is unconfigured', () => {
    const unconfigured = new SolanaChainAdapter(
      stubRpc('10000', 6),
      [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
      null,
    );

    expectErrorCode(
      () => unconfigured.buildVoucherMessage(voucher),
      ChainErrorCode.CHAIN_PROGRAM_NOT_CONFIGURED,
    );
  });

  it('puts the payer, the escrow and the provider at the offsets the program reads', () => {
    const message = adapter.buildVoucherMessage(voucher);

    expect(Array.from(message.subarray(48, 80))).toEqual(addressBytes(signerAddress));
    expect(Array.from(message.subarray(80, 112))).toEqual(addressBytes(PAYER_ADDRESS));
    expect(Array.from(message.subarray(112, 144))).toEqual(addressBytes(PROVIDER_ADDRESS));
  });

  it('signs sha256(resource) rather than the resource string', () => {
    const message = adapter.buildVoucherMessage(voucher);

    expect(Array.from(message.subarray(152, 184))).toEqual(
      Array.from(hashHexToBytes(computeResourceHash(intent.resource))),
    );
    // The whole message is fixed-width, so the string itself is nowhere in it.
    expect(new TextDecoder().decode(message)).not.toContain(intent.resource);
  });

  it('builds the same bytes for the same voucher', () => {
    expect(adapter.buildVoucherMessage(voucher)).toEqual(
      adapter.buildVoucherMessage({ ...voucher }),
    );
  });

  it.each([
    ['amount', { amount: usdc('10001') }],
    ['requestHash', { requestHash: `sha256:${'b4e2d1ef'.repeat(8)}` }],
    ['resource', { resource: `${intent.resource}?v=2` }],
    ['provider', { provider: FACILITATOR }],
    ['seq', { seq: '43' }],
    ['issuedAt', { issuedAt: voucher.issuedAt + 1 }],
    ['expiresAt', { expiresAt: voucher.expiresAt + 1 }],
  ])('builds different bytes when %s changes', (_field, override: Partial<Voucher>) => {
    expect(adapter.buildVoucherMessage(voucher)).not.toEqual(
      adapter.buildVoucherMessage({ ...voucher, ...override }),
    );
  });

  it('verifies a voucher it built', () => {
    expect(adapter.verifyVoucherSignature(voucher, signVoucher(voucher), signer)).toBe(true);
  });

  it('rejects a signature over a tampered voucher', () => {
    const signature = signVoucher(voucher);
    expect(
      adapter.verifyVoucherSignature({ ...voucher, amount: usdc('10001') }, signature, signer),
    ).toBe(false);
    expect(adapter.verifyVoucherSignature({ ...voucher, seq: '43' }, signature, signer)).toBe(
      false,
    );
  });

  it('rejects a genuine signature attributed to another signer', () => {
    const other = generateKeyPairSync('ed25519');
    const otherRaw = other.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
    const otherSigner = `${SOLANA_MAINNET}:${getBase58Decoder().decode(otherRaw)}` as AccountId;
    expect(adapter.verifyVoucherSignature(voucher, signVoucher(voucher), otherSigner)).toBe(false);
  });

  it('rejects a signature made against a different deployment of the program', () => {
    // The whole reason the program id is inside the signed bytes: a voucher
    // signed for yesterday's deployment must not redeem against today's.
    const redeployed = new SolanaChainAdapter(
      stubRpc('10000', 6),
      [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
      ASSAY_PAYMENT_PROGRAM_ADDRESS,
    );

    expect(redeployed.verifyVoucherSignature(voucher, signVoucher(voucher), signer)).toBe(false);
  });

  it('rejects a malformed signature rather than throwing', () => {
    expect(adapter.verifyVoucherSignature(voucher, 'not-a-signature', signer)).toBe(false);
  });

  it('refuses a signer from another namespace', () => {
    expectErrorCode(
      () =>
        adapter.verifyVoucherSignature(
          voucher,
          signVoucher(voucher),
          `${CHAIN_IDS.BASE_MAINNET}:0x8335` as AccountId,
        ),
      ChainErrorCode.CHAIN_NAMESPACE_MISMATCH,
    );
  });
});

/**
 * The payout proof's own message, and its cross-check against the voucher
 * message.
 *
 * The other pairing — payout proof against the stake-authority proof, the
 * closest of the two — lives in
 * `test/unit/chains/solana/stake-authority-message.spec.ts`, not here. Read
 * both when auditing which message pairs are cross-tested.
 */
describe('SolanaChainAdapter — payout proof', () => {
  const keyPair = generateKeyPairSync('ed25519');
  const rawPublicKey = keyPair.publicKey.export({ format: 'der', type: 'spki' }).subarray(12);
  const signerAddress = getBase58Decoder().decode(rawPublicKey);
  const signer = `${SOLANA_MAINNET}:${signerAddress}` as AccountId;

  const challenge: PayoutProofChallenge = {
    account: signer,
    organizationId: 'org-11111111-1111-4111-8111-111111111111',
    nonce: 'd0dfc3aa6a49b2f2d69bb4f1a9d5f7c1d0dfc3aa6a49b2f2d69bb4f1a9d5f7c1',
    expiresAt: 1_786_000_000,
  };

  const signChallenge = (c: PayoutProofChallenge) =>
    getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildPayoutProofMessage(c)), keyPair.privateKey),
    );

  it('leads with its own version tag, distinct from the voucher', () => {
    const message = new TextDecoder().decode(adapter.buildPayoutProofMessage(challenge));
    expect(message.startsWith(PAYOUT_PROOF_MESSAGE_VERSION)).toBe(true);
    expect(message).not.toContain('assay:voucher:v2');
  });

  it('puts the account being claimed inside the signed bytes', () => {
    const other = `${SOLANA_MAINNET}:${VAULT_ATA}` as AccountId;
    expect(adapter.buildPayoutProofMessage(challenge)).not.toEqual(
      adapter.buildPayoutProofMessage({ ...challenge, account: other }),
    );
  });

  it('builds different bytes when the organization id changes', () => {
    expect(adapter.buildPayoutProofMessage(challenge)).not.toEqual(
      adapter.buildPayoutProofMessage({ ...challenge, organizationId: 'org-2222222222' }),
    );
  });

  it('builds different bytes when the nonce changes', () => {
    expect(adapter.buildPayoutProofMessage(challenge)).not.toEqual(
      adapter.buildPayoutProofMessage({ ...challenge, nonce: 'f'.repeat(64) }),
    );
  });

  it('verifies a proof it built', () => {
    expect(adapter.verifyPayoutProofSignature(challenge, signChallenge(challenge), signer)).toBe(
      true,
    );
  });

  /**
   * The headline test: a signature genuinely produced by a wallet other than
   * the one named in the challenge must never verify, however the request
   * frames it. `ProviderPayoutAddressService.prove` always names `signer` as
   * the address stored on the challenge row, never anything from the
   * request, so this is the exact shape of check that path relies on.
   */
  it('rejects a genuine signature made by a different wallet than the one claimed', () => {
    const attacker = generateKeyPairSync('ed25519');
    const attackerSignature = getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildPayoutProofMessage(challenge)), attacker.privateKey),
    );
    expect(adapter.verifyPayoutProofSignature(challenge, attackerSignature, signer)).toBe(false);
  });

  it('rejects a signature over a tampered challenge', () => {
    const signature = signChallenge(challenge);
    const tampered = { ...challenge, account: `${SOLANA_MAINNET}:${VAULT_ATA}` as AccountId };
    expect(adapter.verifyPayoutProofSignature(tampered, signature, signer)).toBe(false);
  });

  it('rejects a malformed signature rather than throwing', () => {
    expect(adapter.verifyPayoutProofSignature(challenge, 'not-a-signature', signer)).toBe(false);
  });

  /**
   * Non-interchangeability in both directions — the property the distinct
   * version tags exist to guarantee. "Prove you own this wallet" must never
   * double as "pay", and neither may double as a payout proof. The other tag,
   * `STAKE_AUTHORITY_MESSAGE_VERSION`, is cross-checked against this one in
   * `test/unit/chains/solana/stake-authority-message.spec.ts`.
   */
  it('refuses a signature made over the voucher message with overlapping fields', () => {
    const asVoucher: Voucher = {
      payer: challenge.account,
      payTo: challenge.account,
      provider: PROVIDER,
      amount: usdc('1'),
      resource: intent.resource,
      requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
      seq: '1',
      issuedAt: challenge.expiresAt - 200,
      expiresAt: challenge.expiresAt,
    };
    const voucherSignature = getBase58Decoder().decode(
      sign(null, Buffer.from(adapter.buildVoucherMessage(asVoucher)), keyPair.privateKey),
    );
    expect(adapter.verifyPayoutProofSignature(challenge, voucherSignature, signer)).toBe(false);
  });

  it('a payout-proof signature does not verify as a voucher', () => {
    const proofSignature = signChallenge(challenge);
    const asVoucher: Voucher = {
      payer: challenge.account,
      payTo: challenge.account,
      provider: PROVIDER,
      amount: usdc('1'),
      resource: intent.resource,
      requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
      seq: '1',
      issuedAt: challenge.expiresAt - 200,
      expiresAt: challenge.expiresAt,
    };
    expect(adapter.verifyVoucherSignature(asVoucher, proofSignature, signer)).toBe(false);
  });
});

describe('SolanaChainAdapter — vault', () => {
  it('derives the associated token account of the vault owner', async () => {
    expect(await adapter.getVaultAccount(VAULT_OWNER, USDC)).toBe(`${SOLANA_MAINNET}:${VAULT_ATA}`);
  });

  it('reads the vault balance as Money in the asset it was asked about', async () => {
    expect(await adapter.getVaultBalance(VAULT_OWNER, USDC)).toEqual(usdc('10000'));
  });

  it('refuses a balance whose on-chain scale disagrees with the asset', async () => {
    const mismatched = new SolanaChainAdapter(stubRpc('10000', 9), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);
    await expectErrorCodeAsync(
      () => mismatched.getVaultBalance(VAULT_OWNER, USDC),
      ChainErrorCode.CHAIN_ASSET_DECIMALS_MISMATCH,
    );
  });
});

describe('SolanaChainAdapter — blockhash', () => {
  it('reads the latest blockhash from the RPC', async () => {
    const adapter = new SolanaChainAdapter(stubRpc('10000', 6), [
      CHAIN_IDS.SOLANA_MAINNET,
      CHAIN_IDS.SOLANA_DEVNET,
    ]);

    await expect(adapter.getLatestBlockhash()).resolves.toEqual({
      blockhash: 'Hash11111',
      lastValidBlockHeight: 123n,
    });
  });
});
