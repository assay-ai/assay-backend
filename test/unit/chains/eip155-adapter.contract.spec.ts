import { secp256k1 } from '@noble/curves/secp256k1';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  keccak256,
  serializeTransaction,
} from 'viem';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import {
  EvmChainAdapter,
  EvmReadClient,
  EvmTransactionReceipt,
} from '@modules/chains/evm/evm-chain.adapter';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { AccountId, CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import {
  ObservedTransfer,
  PaymentIntent,
  PaymentPayload,
  TxRef,
  Voucher,
} from '@modules/chains/ports/x402.types';
import { MoneyUtil } from '@shared/utils/money.util';

import { deployment } from './evm/evm-fixtures';
import { ChainAdapterFixtures, describeChainAdapterContract } from './chain-adapter.contract';

/**
 * `EvmChainAdapter`, run through the shared `ChainAdapter` conformance suite.
 *
 * ## What belongs here and what does not
 *
 * Only the fixture. Every assertion lives in `chain-adapter.contract.ts` and is
 * chain-agnostic; anything naming EIP-55, a `Deposited` event, a keccak digest
 * or a 65-byte signature belongs in `test/unit/chains/evm/`, which keeps those
 * and is not replaced by this file.
 *
 * ## What passing this file does NOT establish
 *
 * The suite's own header says it, and it is worth repeating where the second
 * adapter lands: **no assertion in it requires cryptography.** Every signing
 * case is a consistency check between `build`, `verify` and a signature the
 * fixture supplied, so a keyless `sha256(tag | JSON(value) | signer)` passes
 * them all. What kills that family here is `evm-signing.spec.ts`, which signs
 * with real secp256k1 keys and asserts an attacker's genuine signature, a
 * malleated one and a structured `r`/`s` backdoor are all refused.
 *
 * ## Why the fixture builds real signatures
 *
 * `voucherSignature`, `payoutSignature` and `stakeSignature` are produced by
 * actually signing the adapter's own bytes with freshly generated secp256k1
 * keys. A hand-written constant would be a signature the suite could only ever
 * assert `false` about, which would leave every `toBe(false)` in the contract
 * passing for a verifier that always returns `false`.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
/**
 * A SECOND served chain, which contract assertion 10 needs: a comparison the
 * adapter's own "do I serve this?" guard cannot pre-empt. Base Sepolia is a
 * real CAIP-2 id in this namespace, and the fixture's deployment map gives it
 * its own escrow so nothing is shared with `TESTNET`.
 */
const SERVED_OTHER = CHAIN_IDS.BASE_SEPOLIA;
/**
 * In this namespace, NOT served — assertion 22's real subject.
 *
 * `eip155:4663` is Robinhood **mainnet**, which the fixture's deployment map
 * does not include: an adapter whose guard is namespace equality serves it
 * happily.
 */
const UNSERVED_SAME_NAMESPACE = CHAIN_IDS.ROBINHOOD_MAINNET;

const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;
const TESTNET_DEPLOYMENT = deployment(TESTNET);

/** The escrow contract's CAIP-10 — what a voucher names as `payTo` on eip155. */
const ESCROW_ACCOUNT = `${TESTNET}:${TESTNET_DEPLOYMENT.escrow}` as AccountId;

const PROVIDER = `${TESTNET}:0xAb8483F64d9C6d1EcF9b849Ae677dD3315835cb2` as AccountId;
const RELAYER = `${TESTNET}:0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` as AccountId;

const SETTLED_HASH = `0x${'ab'.repeat(32)}` as TxRef;
const UNKNOWN_HASH = `0x${'cd'.repeat(32)}` as TxRef;

/**
 * The credit and the balance it produced.
 *
 * The suite states this as an obligation the fixture author has to meet and it
 * cannot check: the opening balance is non-zero, so an adapter reporting the
 * post-transaction balance rather than the delta fails rather than coinciding.
 */
const DEPOSITED_AMOUNT = 3_200n;
const RESULTING_BALANCE = 4_200n;

const usdg = (amount: string) => MoneyUtil.of(amount, USDG, 6);

interface Secp256k1Signer {
  readonly account: AccountId;
  readonly address: `0x${string}`;
  /** Over the adapter's own bytes, which on EVM are already a 32-byte digest. */
  readonly sign: (digest: Uint8Array) => string;
}

function generateSigner(): Secp256k1Signer {
  const privateKey = secp256k1.utils.randomPrivateKey();
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const address = getAddress(`0x${keccak256(publicKey.subarray(1)).slice(-40)}`);
  return {
    account: `${TESTNET}:${address}` as AccountId,
    address,
    sign: (digest) => {
      // `lowS` is noble's default, which is what signing requires — a high-`s`
      // signature is a second valid encoding of the same approval and breaks
      // any off-chain idempotency keyed on the signature string.
      const signature = secp256k1.sign(digest, privateKey);
      const v = (27 + signature.recovery).toString(16).padStart(2, '0');
      return `0x${signature.toCompactHex()}${v}`;
    },
  };
}

const voucherSigner = generateSigner();
const payoutSigner = generateSigner();
const stakeSigner = generateSigner();
/** A fourth, independent key. Signs the same three values as the other three. */
const secondSigner = generateSigner();

function depositedLog(args: { buyer: string; amount: bigint; balance: bigint }) {
  return {
    address: TESTNET_DEPLOYMENT.escrow,
    topics: encodeEventTopics({
      abi: ASSAY_ESCROW_ABI,
      eventName: 'Deposited',
      args: { buyer: args.buyer as `0x${string}`, funder: args.buyer as `0x${string}` },
    }) as `0x${string}`[],
    data: encodeAbiParameters(
      [
        { name: 'amount', type: 'uint64' },
        { name: 'balance', type: 'uint128' },
      ],
      [args.amount, args.balance],
    ),
  };
}

const SETTLED_RECEIPT: EvmTransactionReceipt = {
  status: 'success',
  blockNumber: 100n,
  logs: [
    depositedLog({
      buyer: voucherSigner.address,
      amount: DEPOSITED_AMOUNT,
      balance: RESULTING_BALANCE,
    }),
  ],
};

const stubClient = (): EvmReadClient => ({
  getTransactionReceipt: async ({ hash }) =>
    hash === (SETTLED_HASH as string)
      ? SETTLED_RECEIPT
      : Promise.reject(new Error('TransactionReceiptNotFoundError')),
  getBlock: async () => ({ number: 100n }),
  getBlockNumber: async () => 100n,
  readContract: async () => ({
    balance: 10_000n,
    seqHigh: 7n,
    authNonce: 8n,
    maxVoucherAmount: 20n,
    maxPerWindow: 21n,
    spentInWindow: 22n,
    windowStartedAt: 23n,
    withdrawRequested: 24n,
    withdrawAvailableAt: 25n,
    totalRedeemed: 26n,
    totalWithdrawn: 27n,
    totalFunded: 28n,
  }),
});

const SERVED_CHAINS: readonly ChainId[] = [TESTNET, SERVED_OTHER];

const buildAdapter = (): EvmChainAdapter =>
  new EvmChainAdapter(
    new Map([
      [TESTNET, stubClient()],
      [SERVED_OTHER, stubClient()],
    ]),
    new Map([
      [TESTNET, TESTNET_DEPLOYMENT],
      [SERVED_OTHER, deployment(SERVED_OTHER)],
    ]),
    SERVED_CHAINS,
  );

/** Used once, to sign the fixtures. The contract gets a fresh adapter per test. */
const signingAdapter = buildAdapter();

const intent: PaymentIntent = {
  id: 'pi_01J8XZQ4M0000000000000',
  resource: 'https://api.platform.io/tools/search_web',
  amount: usdg('10000'),
  // The pooled contract, as `DepositService` passes it; the buyer is `payer`.
  payTo: ESCROW_ACCOUNT,
  payer: voucherSigner.account,
  chainId: TESTNET,
  expiresAt: new Date('2026-09-09T00:01:00.000Z'),
};

const voucher: Voucher = {
  payer: voucherSigner.account,
  // On eip155 this is the escrow CONTRACT, not a per-buyer PDA: one contract
  // holds every buyer (`buyer_escrows.escrow_account_id`).
  payTo: ESCROW_ACCOUNT,
  provider: PROVIDER,
  amount: usdg('10000'),
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
 * on the data rather than on the primary type.
 */
const stakeChallenge: StakeAuthorityChallenge = {
  account: stakeSigner.account,
  organizationId: payoutChallenge.organizationId,
  nonce: payoutChallenge.nonce,
  expiresAt: payoutChallenge.expiresAt,
};

/** A serialized `depositFor` — the transaction a buyer signs on this chain. */
function depositTransaction(buyer: `0x${string}`): `0x${string}` {
  return serializeTransaction(
    {
      type: 'eip1559',
      chainId: 46_630,
      to: TESTNET_DEPLOYMENT.escrow,
      value: 0n,
      nonce: 3,
      gas: 120_000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1n,
      data: encodeFunctionData({
        abi: ASSAY_ESCROW_ABI,
        functionName: 'depositFor',
        args: [buyer, 10_000n],
      }),
    },
    { r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, v: 27n },
  );
}

const boundPayload: PaymentPayload = {
  x402Version: 2,
  scheme: 'exact',
  network: TESTNET,
  payload: { transaction: depositTransaction(voucherSigner.address) },
};

/** Well-formed, and a deposit for somebody else — bound to another intent. */
const unboundPayload: PaymentPayload = {
  ...boundPayload,
  payload: { transaction: depositTransaction(payoutSigner.address) },
};

const settledTransfer: ObservedTransfer = {
  amount: DEPOSITED_AMOUNT.toString(),
  asset: USDG,
  decimals: 6,
};

const fixtures: ChainAdapterFixtures = {
  chainId: TESTNET,
  servedOtherChainId: SERVED_OTHER,
  otherNamespaceChainId: CHAIN_IDS.SOLANA_MAINNET,
  unservedSameNamespaceChainId: UNSERVED_SAME_NAMESPACE,
  validAddress: voucherSigner.address,
  // A valid address — on a chain in another namespace.
  invalidAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  asset: USDG,
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
    chainId: TESTNET,
    intentId: intent.id,
    resource: intent.resource,
    amount: intent.amount,
    payTo: voucherSigner.account,
    // Equal to `payTo` here on purpose: the shared contract asserts the
    // chain-agnostic property that `payTo` is the DERIVED vault account, and
    // the two fields only diverge on EVM. The case where they differ — and the
    // one that catches an adapter reading the wrong one — is
    // `evm/evm-chain.adapter.x402.spec.ts`'s "follows `payer` and not `payTo`".
    payer: voucherSigner.account,
    feePayer: RELAYER,
  },
  settledTransaction: SETTLED_HASH,
  settledTransfer,
  unknownTransaction: UNKNOWN_HASH,
};

describeChainAdapterContract('EvmChainAdapter', buildAdapter, fixtures);
