import { generateKeyPairSync, KeyObject, sign } from 'node:crypto';

import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';

import { AccountId, AssetId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import {
  ObservedTransfer,
  PaymentIntent,
  PaymentPayload,
  TxRef,
  Voucher,
} from '@modules/chains/ports/x402.types';
import { MEMO_PROGRAM_ADDRESS } from '@modules/chains/solana/solana.constants';
import { SolanaChainAdapter, SolanaRpcClient } from '@modules/chains/solana/solana-chain.adapter';
import { MoneyUtil } from '@shared/utils/money.util';

import { ChainAdapterFixtures, describeChainAdapterContract } from './chain-adapter.contract';

/**
 * The Solana adapter, run through the shared `ChainAdapter` conformance suite.
 *
 * ## What belongs here and what does not
 *
 * Only the fixture. Every assertion lives in `chain-adapter.contract.ts` and is
 * chain-agnostic; anything that names base58, 240 bytes, an ATA derivation or a
 * memo instruction belongs in `solana-chain.adapter.spec.ts`, which keeps those
 * and is not replaced by this file. The two are complementary: that spec pins
 * Solana's behaviour, this one pins the port's properties.
 *
 * ## Why the fixture builds real signatures
 *
 * `voucherSignature`, `payoutSignature` and `stakeSignature` are produced by
 * actually signing the adapter's own bytes with a freshly generated ed25519
 * key. A hand-written constant would be a signature the suite could only ever
 * assert `false` about, which would leave every `toBe(false)` in the contract
 * passing for a verifier that always returns `false`.
 */

const SOLANA_MAINNET = CHAIN_IDS.SOLANA_MAINNET;
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC = `${SOLANA_MAINNET}/token:${USDC_MINT}` as AssetId;

const PAYER_ADDRESS = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const VAULT_OWNER = `${SOLANA_MAINNET}:${PAYER_ADDRESS}` as AccountId;
const PROVIDER = `${SOLANA_MAINNET}:9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM` as AccountId;
const FACILITATOR = `${SOLANA_MAINNET}:H9ityXJKWiwTni6DD5kEA1Hrqi4CSkBU4RyPx1FyHqPp` as AccountId;

/**
 * The only EVM chain id in the production scope fence, and it is a test
 * fixture — the contract needs a well-formed chain id from a namespace this
 * adapter must refuse, and inventing one would be inventing a namespace.
 */
const ROBINHOOD_TESTNET = 'eip155:46630' as ChainId;

/**
 * Solana **testnet** — a real CAIP-2 chain id (the first 32 characters of that
 * cluster's genesis hash) in this adapter's own namespace, which no deployment
 * here enables.
 *
 * This is what assertion 22 needs and what `CHAIN_IDS` cannot supply: mainnet
 * and devnet are both in the fixture's `ENABLED_CHAINS`, deliberately, because
 * assertion 10 needs a SECOND served chain. A guard written as namespace
 * equality serves this chain id happily, which is the whole point of probing
 * with it.
 */
const SOLANA_TESTNET = 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' as ChainId;

/** Deployed, deliberately not `X402_PAYMENT_PROGRAM_ADDRESS`. See the adapter spec. */
const DEPLOYED_PROGRAM_ID = 'PR5bEscrowRedep1oyment11111111111111111111z';

/** A transaction the stub RPC can find, and one it cannot. */
const SETTLED_SIGNATURE =
  'ydCsGMwjmrjS24G3YAoXt2XaCjkTByiXe3PZAu6MynnXtZixsPXaeMu6s9gQXrPUQ6uSCzXKrt1DedxTjTEgL8u' as TxRef;
const UNKNOWN_SIGNATURE =
  'Eha1gLpfwHKnYiSitW4RJwYZ6F7Ve95qj5Pvi2PGFVimxGmP8uG8rjNJQwCTU3CXZzkETjnFhLnzsLy7gaEAU8d' as TxRef;

/**
 * The vault's balance before and after {@link SETTLED_SIGNATURE}.
 *
 * `before` is deliberately non-zero: `observeTransfer` must report the delta,
 * and an implementation that returned the post-transaction balance would be
 * indistinguishable from a correct one if the account had started empty.
 */
const VAULT_BALANCE_BEFORE = '1000';
const VAULT_BALANCE_AFTER = '4200';
const OBSERVED_DELTA = '3200';

const usdc = (amount: string) => MoneyUtil.of(amount, USDC, 6);

interface Ed25519Signer {
  readonly account: AccountId;
  readonly sign: (message: Uint8Array) => string;
}

function generateSigner(): Ed25519Signer {
  const keyPair = generateKeyPairSync('ed25519');
  const raw = (keyPair.publicKey as KeyObject).export({ format: 'der', type: 'spki' }).subarray(12);
  return {
    account: `${SOLANA_MAINNET}:${getBase58Decoder().decode(raw)}` as AccountId,
    sign: (message) =>
      getBase58Decoder().decode(sign(null, Buffer.from(message), keyPair.privateKey)),
  };
}

function transactionWithMemo(memo: string): string {
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
        [
          {
            programAddress: address(MEMO_PROGRAM_ADDRESS),
            accounts: [],
            data: new TextEncoder().encode(memo),
          },
        ],
        m,
      ),
  );
  return getBase64Decoder().decode(getTransactionEncoder().encode(compileTransaction(message)));
}

const tokenBalance = (amount: string) => ({
  owner: PAYER_ADDRESS,
  mint: USDC_MINT,
  uiTokenAmount: { amount, decimals: 6 },
});

function stubRpc(): SolanaRpcClient {
  return {
    getTokenAccountBalance: () => ({
      send: async () => ({ value: { amount: '10000', decimals: 6 } }),
    }),
    getTransaction: (signature: string) => ({
      send: async () =>
        signature === (SETTLED_SIGNATURE as string)
          ? {
              meta: {
                err: null,
                preTokenBalances: [tokenBalance(VAULT_BALANCE_BEFORE)],
                postTokenBalances: [tokenBalance(VAULT_BALANCE_AFTER)],
              },
            }
          : null,
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: 'Hash11111', lastValidBlockHeight: 123n } }),
    }),
  } as SolanaRpcClient;
}

const buildAdapter = (): SolanaChainAdapter =>
  new SolanaChainAdapter(
    stubRpc(),
    [CHAIN_IDS.SOLANA_MAINNET, CHAIN_IDS.SOLANA_DEVNET],
    DEPLOYED_PROGRAM_ID,
  );

/** Used once, to sign the fixtures. The contract gets a fresh adapter per test. */
const signingAdapter = buildAdapter();

const voucherSigner = generateSigner();
const payoutSigner = generateSigner();
const stakeSigner = generateSigner();
/** A fourth, independent key. Signs the same three values as the other three. */
const secondSigner = generateSigner();

const intent: PaymentIntent = {
  id: 'pi_01J8XZQ4M0000000000000',
  resource: 'https://api.platform.io/tools/search_web',
  amount: usdc('10000'),
  payTo: VAULT_OWNER,
  // Unread on Solana — the escrow PDA is both owner and balance.
  payer: voucherSigner.account,
  chainId: SOLANA_MAINNET,
  expiresAt: new Date('2026-08-13T00:01:00.000Z'),
};

const voucher: Voucher = {
  payer: voucherSigner.account,
  payTo: VAULT_OWNER,
  provider: PROVIDER,
  amount: usdc('10000'),
  resource: intent.resource,
  requestHash: `sha256:${'a3f1c0de'.repeat(8)}`,
  seq: '42',
  issuedAt: 1_785_999_800,
  expiresAt: 1_786_000_000,
};

const payoutChallenge: PayoutProofChallenge = {
  account: payoutSigner.account,
  organizationId: 'org-11111111-1111-4111-8111-111111111111',
  nonce: 'd0dfc3aa6a49b2f2d69bb4f1a9d5f7c1d0dfc3aa6a49b2f2d69bb4f1a9d5f7c1',
  expiresAt: 1_786_000_000,
};

/**
 * The same four values as {@link payoutChallenge}, one wallet apart.
 *
 * Deliberately not "obviously different": contract assertion 20 is about two
 * proofs whose fields are the same and whose meanings are not, so a fixture
 * that varied the nonce and the expiry would make the distinctness check pass
 * on the data rather than on the domain tag.
 */
const stakeChallenge: StakeAuthorityChallenge = {
  account: stakeSigner.account,
  organizationId: payoutChallenge.organizationId,
  nonce: payoutChallenge.nonce,
  expiresAt: payoutChallenge.expiresAt,
};

const boundPayload: PaymentPayload = {
  x402Version: 2,
  scheme: 'exact',
  network: SOLANA_MAINNET,
  payload: { transaction: transactionWithMemo(intent.id) },
};

const unboundPayload: PaymentPayload = {
  ...boundPayload,
  payload: { transaction: transactionWithMemo('pi_someone_elses_intent') },
};

const settledTransfer: ObservedTransfer = {
  amount: OBSERVED_DELTA,
  asset: USDC,
  decimals: 6,
};

const fixtures: ChainAdapterFixtures = {
  chainId: SOLANA_MAINNET,
  servedOtherChainId: CHAIN_IDS.SOLANA_DEVNET,
  otherNamespaceChainId: ROBINHOOD_TESTNET,
  unservedSameNamespaceChainId: SOLANA_TESTNET,
  validAddress: PAYER_ADDRESS,
  // A valid address — on a chain in another namespace.
  invalidAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  asset: USDC,
  voucher,
  voucherSignature: voucherSigner.sign(signingAdapter.buildVoucherMessage(voucher)),
  voucherSigner: voucherSigner.account,
  payoutChallenge,
  payoutSignature: payoutSigner.sign(signingAdapter.buildPayoutProofMessage(payoutChallenge)),
  payoutSigner: payoutSigner.account,
  stakeChallenge,
  stakeSignature: stakeSigner.sign(signingAdapter.buildStakeAuthorityMessage(stakeChallenge)),
  stakeSigner: stakeSigner.account,
  secondSigner: secondSigner.account,
  voucherSignatureBySecondSigner: secondSigner.sign(signingAdapter.buildVoucherMessage(voucher)),
  payoutSignatureBySecondSigner: secondSigner.sign(
    signingAdapter.buildPayoutProofMessage(payoutChallenge),
  ),
  stakeSignatureBySecondSigner: secondSigner.sign(
    signingAdapter.buildStakeAuthorityMessage(stakeChallenge),
  ),
  intent,
  boundPayload,
  unboundPayload,
  requirementsInput: {
    chainId: SOLANA_MAINNET,
    intentId: intent.id,
    resource: intent.resource,
    amount: intent.amount,
    payTo: VAULT_OWNER,
    // On SVM the account that receives the transfer IS the balance, so `payer`
    // adds nothing and this adapter never reads it. See
    // `BuildRequirementsInput.payer`.
    payer: VAULT_OWNER,
    feePayer: FACILITATOR,
  },
  settledTransaction: SETTLED_SIGNATURE,
  settledTransfer,
  unknownTransaction: UNKNOWN_SIGNATURE,
};

describeChainAdapterContract('SolanaChainAdapter', buildAdapter, fixtures);
