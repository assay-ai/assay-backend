/// <reference types="node" />
/**
 * `yarn testnet:e2` — acceptance criterion E2 against the LIVE `eip155:46630` deployment.
 *
 * > A buyer funds USDG, sets limits, signs an EIP-712 voucher, the platform redeems it, and the
 * > provider's USDG balance increases by `amount − fee` in one transaction.
 *
 * ## Who plays which part
 *
 * - **The buyer is a scripted identity holding its own key** (`TESTNET_E2_BUYER_KEY`), because
 *   that is what an x402 client is: no screen in the product signs a voucher, and a Privy
 *   embedded key cannot be exported. It pays its own gas for `approve`, `deposit` and
 *   `setLimits`, exactly as a real buyer does. The key lives outside the repo.
 * - **The platform is the platform's own code**: `EvmVoucherRedeemer`, resolved out of the real
 *   Nest graph and sending through the real `EvmRelayer` with the configured REDEEMER key
 *   (`EVM_REDEEMER_KEYS`, never the relayer's). The
 *   script never builds or sends a `redeemVoucher` itself — a redemption the script sent would
 *   prove the contract, which the fork suite already does, and not the platform.
 * - **The provider** is whoever `TESTNET_E2_PROVIDER` names (required; there is no default
 *   provider). It must already hold `minimumStake` bonded, or the contract refuses with
 *   `ProviderBelowMinimumStake` — which is a precondition this script reports, not works around.
 *
 * ## What is asserted, and against what
 *
 * The provider's balance is read at the redemption's own block and at the block before it, so
 * the delta is THIS transaction's and not a neighbour's. It must equal `amount − fee`, where
 * `fee` is read off the `VoucherRedeemed` event the same transaction emitted — never computed
 * here from a take rate the script assumed.
 *
 * ## What it does NOT prove
 *
 * The voucher is signed here, not issued by `VoucherService` behind a paid rail-B call. That is
 * the half a published eip155 binding with a live upstream would exercise, and it is named in
 * the result's `unproven` rather than implied.
 *
 * Prints one `E2_RESULT {json}` line and exits 0 only on PASSED.
 */
import { randomBytes } from 'node:crypto';

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
  parseEventLogs,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { voucherTypedData } from '@modules/chains/evm/eip712/voucher';
import { EvmVoucherRedeemer } from '@modules/chains/evm/evm-voucher-redeemer.service';
import { X402_CONFIG_ABI, X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { ChainId, toAccountId, toAssetId } from '@modules/chains/ports/caip.types';
import { RedeemOutcomeKind } from '@modules/payment/ports/voucher-redeemer.port';
import { MoneyUtil } from '@shared/utils/money.util';

import { bootAppContext } from '../devnet/lib/app-context';

const CHAIN_ID = 'eip155:46630' as ChainId;
/** One USDG. Small on purpose: this is evidence, not load. */
const AMOUNT = 1_000_000n;
/** Well under `VOUCHER_MAX_LIFETIME_SECONDS` (300), so a slow redemption still lands. */
const LIFETIME_SECONDS = 240n;

const TOKEN_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  // The testnet USDG is a faucet token.
  'function claim()',
]);

interface E2Result {
  outcome: 'PASSED' | 'FAILED';
  evidence: string;
  unproven: string | null;
  detail?: Record<string, unknown>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(): Promise<E2Result> {
  const rpcUrl = (JSON.parse(required('EVM_RPC_URLS')) as Record<string, string>)[CHAIN_ID];
  const deployment = (
    JSON.parse(required('EVM_DEPLOYMENTS')) as Record<string, Record<string, string>>
  )[CHAIN_ID];
  if (!rpcUrl || !deployment) throw new Error(`EVM_RPC_URLS / EVM_DEPLOYMENTS lack ${CHAIN_ID}`);

  const buyer = privateKeyToAccount(required('TESTNET_E2_BUYER_KEY') as `0x${string}`);
  const provider = getAddress(required('TESTNET_E2_PROVIDER'));
  const escrow = getAddress(deployment.escrow);
  const token = getAddress(deployment.asset);
  const config = getAddress(deployment.config);

  const chain = defineChain({
    id: 46630,
    name: 'Robinhood Chain testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const wallet = createWalletClient({ account: buyer, chain, transport: http(rpcUrl) });

  const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
    const hash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    console.log(`  ${label}: ${hash}`);
    return hash;
  };

  // ── 1. The buyer funds USDG ─────────────────────────────────────────────
  if ((await pub.getBalance({ address: buyer.address })) === 0n) {
    return {
      outcome: 'FAILED',
      evidence: `the scripted buyer ${buyer.address} holds no ETH, and a buyer pays its own gas`,
      unproven: null,
    };
  }
  const readEscrow = async () =>
    (await pub.readContract({
      address: escrow,
      abi: X402_ESCROW_ABI,
      functionName: 'escrowOf',
      args: [buyer.address],
    })) as {
      balance: bigint;
      seqHigh: bigint;
      maxVoucherAmount: bigint;
      maxPerWindow: bigint;
    };

  let state = await readEscrow();
  if (state.balance < AMOUNT) {
    const held = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [buyer.address],
    });
    if (held < AMOUNT) {
      await send('USDG faucet claim()', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'claim',
      } as never);
    }
    const allowance = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'allowance',
      args: [buyer.address, escrow],
    });
    if (allowance < AMOUNT) {
      await send('approve(escrow)', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'approve',
        args: [escrow, AMOUNT],
      } as never);
    }
    await send('deposit', {
      address: escrow,
      abi: X402_ESCROW_ABI,
      functionName: 'deposit',
      args: [AMOUNT],
    } as never);
  }

  // ── 2. …sets limits ─────────────────────────────────────────────────────
  state = await readEscrow();
  if (state.maxVoucherAmount < AMOUNT || state.maxPerWindow < AMOUNT * 10n) {
    await send('setLimits', {
      address: escrow,
      abi: X402_ESCROW_ABI,
      functionName: 'setLimits',
      args: [AMOUNT * 2n, AMOUNT * 20n],
    } as never);
    state = await readEscrow();
  }

  // ── 3. …signs an EIP-712 voucher, as an x402 client does ────────────────
  const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp;
  const voucher = {
    payer: buyer.address,
    provider,
    amount: AMOUNT,
    resourceHash: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    requestHash: `0x${randomBytes(32).toString('hex')}` as `0x${string}`,
    seq: state.seqHigh + 1n,
    issuedAt: now,
    expiresAt: now + LIFETIME_SECONDS,
  };
  const signature = await buyer.signTypedData(
    voucherTypedData(voucher, evmDomain(CHAIN_ID, escrow)),
  );

  // ── 4. …the PLATFORM redeems it ─────────────────────────────────────────
  const app = await bootAppContext();
  const redeemer = app.get(EvmVoucherRedeemer, { strict: false });
  const asset = toAssetId(CHAIN_ID, 'erc20', token);
  const outcome = await redeemer.redeem({
    payer: toAccountId(CHAIN_ID, buyer.address),
    provider: toAccountId(CHAIN_ID, provider),
    amount: MoneyUtil.of(AMOUNT, asset, 6),
    asset,
    resourceHash: `sha256:${voucher.resourceHash.slice(2)}`,
    requestHash: voucher.requestHash.slice(2),
    seq: voucher.seq.toString(),
    issuedAt: Number(voucher.issuedAt),
    expiresAt: Number(voucher.expiresAt),
    signature,
  });
  if (outcome.kind !== RedeemOutcomeKind.REDEEMED || !outcome.signature) {
    return {
      outcome: 'FAILED',
      evidence: `EvmVoucherRedeemer answered ${outcome.kind} (${outcome.programError ?? 'no error'})`,
      unproven: null,
    };
  }

  // ── 5. …and the provider is credited amount − fee, in THAT transaction ──
  const hash = outcome.signature as `0x${string}`;
  const receipt = await pub.getTransactionReceipt({ hash });
  const [redeemed] = parseEventLogs({
    abi: X402_ESCROW_ABI,
    eventName: 'VoucherRedeemed',
    logs: receipt.logs.filter((log) => getAddress(log.address) === escrow),
  });
  if (!redeemed) {
    return { outcome: 'FAILED', evidence: `${hash} emitted no VoucherRedeemed`, unproven: null };
  }
  const balanceAt = (blockNumber: bigint) =>
    pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [provider],
      blockNumber,
    });
  const [before, after, params] = await Promise.all([
    balanceAt(receipt.blockNumber - 1n),
    balanceAt(receipt.blockNumber),
    pub.readContract({ address: config, abi: X402_CONFIG_ABI, functionName: 'params' }),
  ]);
  const { amount, fee, payer, seq } = redeemed.args;
  const delta = after - before;
  const detail = {
    redemption: hash,
    block: receipt.blockNumber.toString(),
    sentBy: receipt.from,
    redeemer: params.redeemer,
    payer,
    provider: redeemed.args.provider,
    seq: seq.toString(),
    amount: amount.toString(),
    fee: fee.toString(),
    takeRateBps: params.takeRateBps,
    providerBefore: before.toString(),
    providerAfter: after.toString(),
  };

  const checks: [boolean, string][] = [
    [delta === amount - fee, `provider delta ${delta} === amount − fee ${amount - fee}`],
    [amount === AMOUNT, `event amount ${amount} === voucher amount ${AMOUNT}`],
    [getAddress(payer) === buyer.address, 'event payer is the scripted buyer'],
    [getAddress(redeemed.args.provider) === provider, 'event provider is the provider'],
    [seq === voucher.seq, `event seq ${seq} === voucher seq ${voucher.seq}`],
    [
      getAddress(receipt.from) === getAddress(params.redeemer),
      `sent by the configured redeemer ${params.redeemer}, i.e. the platform's redeemer key`,
    ],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  return failed.length > 0
    ? { outcome: 'FAILED', evidence: `not true: ${failed.join('; ')}`, unproven: null, detail }
    : {
        outcome: 'PASSED',
        evidence:
          `redeemed by the platform in ${hash} (block ${receipt.blockNumber}); provider ` +
          `${provider} +${delta} = ${amount} − fee ${fee} in that block`,
        unproven:
          'the voucher was signed by the scripted client, not issued by VoucherService behind a ' +
          'paid rail-B call — that half needs a published eip155 binding with a live upstream.',
        detail,
      };
}

run()
  .then((result) => {
    console.log(`E2_RESULT ${JSON.stringify(result)}`);
    // `RedisCacheModule` never closes its client, so a booted context never lets node exit.
    process.exit(result.outcome === 'PASSED' ? 0 : 1);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.log(
      `E2_RESULT ${JSON.stringify({ outcome: 'FAILED', evidence: `threw: ${message}`, unproven: null })}`,
    );
    process.exit(1);
  });
