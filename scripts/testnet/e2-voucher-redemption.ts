/// <reference types="node" />
/**
 * `yarn testnet:e2` — acceptance criterion E2 against the LIVE `eip155:46630` deployment.
 *
 * > A buyer funds USDG, sets limits, signs an EIP-712 voucher, the platform redeems it, and the
 * > provider's USDG balance increases by `amount − fee`.
 *
 * On a shared chain the hold has no database row for the backend's own mirror, so the dev
 * reconciliation reports one `HELD_MIRROR_DRIFT` (WARN) until the collect lands; a FAILED after
 * the redemption names the payer and seq left held, to collect or refund by hand.
 *
 * Since the dispute hold (redeem-into-hold, 2026-10-18) a redemption moves the money into
 * `held[payer][seq]` and pays nobody: the provider is paid when the platform's collector calls
 * `collectHeld` at or after `collectableAt`. So the criterion is checked in two transactions: the
 * redemption (a `PaymentHeld`, the provider untouched) and the platform's collect (the provider
 * `+ providerAmount` in that block, `providerAmount + fee == amount`).
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
 * The provider's balance is read at each transaction's own block and at the block before it, so
 * each delta is THAT transaction's and not a neighbour's: 0 at the redemption, and at the collect
 * `providerAmount` from the `HeldCollected` event that transaction emitted, which must equal
 * `amount − fee` with `fee` read off the redemption's `VoucherRedeemed` — never computed here from
 * a take rate the script assumed.
 *
 * ## Waiting out the hold
 *
 * On the live chain the script waits, polling chain time, until `collectableAt` (at most
 * `E2_MAX_WAIT_SECONDS`, default 7,500 — the hold is one hour, rounded to the block). On a local
 * chain or a fork, `E2_ADVANCE_TIME=1` moves the chain's clock instead (`evm_increaseTime`); it is
 * refused on chain 46630 itself only by the node, which does not offer that method.
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
import { ASSAY_CONFIG_ABI, ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import { ASSAY_ESCROW_HOLD_ABI } from '@modules/chains/evm/abi/assay-hold.abi';
import { EvmHeldPayments } from '@modules/chains/evm/evm-held-payments.service';
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
      abi: ASSAY_ESCROW_ABI,
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
      abi: ASSAY_ESCROW_ABI,
      functionName: 'deposit',
      args: [AMOUNT],
    } as never);
  }

  // ── 2. …sets limits ─────────────────────────────────────────────────────
  state = await readEscrow();
  if (state.maxVoucherAmount < AMOUNT || state.maxPerWindow < AMOUNT * 10n) {
    await send('setLimits', {
      address: escrow,
      abi: ASSAY_ESCROW_ABI,
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

  // `E2_ADVANCE_TIME` moves the clock with `evm_increaseTime`, which only a local node offers:
  // refuse it before anything is redeemed rather than after (a live node would leave the held
  // payment stranded with no database row).
  const advanceTime = process.env.E2_ADVANCE_TIME === '1';
  if (advanceTime) {
    const client = String(
      await pub.request({ method: 'web3_clientVersion' as never, params: [] as never }),
    );
    if (!/anvil|hardhat/i.test(client)) {
      return {
        outcome: 'FAILED',
        evidence: `E2_ADVANCE_TIME=1 needs a local node (anvil/hardhat); this one is ${client}`,
        unproven: null,
      };
    }
  }
  const maxWaitSeconds = Number(process.env.E2_MAX_WAIT_SECONDS ?? '7500');
  if (!Number.isFinite(maxWaitSeconds) || maxWaitSeconds <= 0) {
    throw new Error(
      `E2_MAX_WAIT_SECONDS must be a positive number, got ${process.env.E2_MAX_WAIT_SECONDS}`,
    );
  }

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

  // ── 5. …into hold: a `PaymentHeld`, and the provider is not paid yet ────
  const hash = outcome.signature as `0x${string}`;
  const receipt = await pub.getTransactionReceipt({ hash });
  const escrowLogs = receipt.logs.filter((log) => getAddress(log.address) === escrow);
  const [redeemed] = parseEventLogs({
    abi: ASSAY_ESCROW_ABI,
    eventName: 'VoucherRedeemed',
    logs: escrowLogs,
  });
  const [heldLog] = parseEventLogs({
    abi: ASSAY_ESCROW_HOLD_ABI,
    eventName: 'PaymentHeld',
    logs: escrowLogs,
  });
  if (!redeemed) {
    return { outcome: 'FAILED', evidence: `${hash} emitted no VoucherRedeemed`, unproven: null };
  }
  if (!heldLog) {
    return {
      outcome: 'FAILED',
      evidence: `${hash} emitted no PaymentHeld (not a hold escrow?)`,
      unproven: null,
    };
  }
  const balanceAt = (blockNumber: bigint) =>
    pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [provider],
      blockNumber,
    });
  const [beforeRedeem, afterRedeem, params] = await Promise.all([
    balanceAt(receipt.blockNumber - 1n),
    balanceAt(receipt.blockNumber),
    pub.readContract({ address: config, abi: ASSAY_CONFIG_ABI, functionName: 'params' }),
  ]);
  const { amount, fee, payer, seq } = redeemed.args;
  const collectableAt = heldLog.args.collectableAt;
  // Every FAILED from here on leaves a held payment with no database row: name it, so it can be
  // collected (or refunded) by hand.
  const stranded = `held payment payer ${buyer.address} seq ${voucher.seq} stays held`;

  // ── 6. …the hold runs out… ──────────────────────────────────────────────
  const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp;
  if (advanceTime) {
    const gap = collectableAt - (await chainNow());
    if (gap > 0n) {
      await pub.request({
        method: 'evm_increaseTime' as never,
        params: [Number(gap) + 1] as never,
      });
      await pub.request({ method: 'evm_mine' as never, params: [] as never });
    }
  } else {
    const deadline = Date.now() + maxWaitSeconds * 1000;
    while ((await chainNow()) < collectableAt) {
      if (Date.now() > deadline) {
        return {
          outcome: 'FAILED',
          evidence: `held until ${collectableAt}; E2_MAX_WAIT_SECONDS ran out before it matured; ${stranded}`,
          unproven: null,
        };
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }

  // ── 7. …and the PLATFORM's collector pays the provider amount − fee ─────
  const heldPayments = app.get(EvmHeldPayments, { strict: false });
  const key = { payer: toAccountId(CHAIN_ID, buyer.address), seq: voucher.seq.toString() };
  // A fee spike, the hourly budget or a busy redeemer queue defers a collect without sending it;
  // the platform's job simply retries on its next pass, and so does this.
  let txRef: string | null = null;
  for (let attempt = 1; txRef === null; attempt++) {
    try {
      ({ txRef } = await heldPayments.collect(asset, [key]));
    } catch (error) {
      if (attempt >= 5) {
        const message = error instanceof Error ? error.message : String(error);
        return { outcome: 'FAILED', evidence: `collect: ${message}; ${stranded}`, unproven: null };
      }
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
  const collectReceipt = await pub.waitForTransactionReceipt({
    hash: txRef as `0x${string}`,
    timeout: 120_000,
  });
  const [collectedLog] = parseEventLogs({
    abi: ASSAY_ESCROW_HOLD_ABI,
    eventName: 'HeldCollected',
    logs: collectReceipt.logs.filter((log) => getAddress(log.address) === escrow),
  });
  if (!collectedLog) {
    return {
      outcome: 'FAILED',
      evidence: `${txRef} emitted no HeldCollected; ${stranded}`,
      unproven: null,
    };
  }
  const [beforeCollect, afterCollect] = await Promise.all([
    balanceAt(collectReceipt.blockNumber - 1n),
    balanceAt(collectReceipt.blockNumber),
  ]);
  const paid = afterCollect - beforeCollect;
  const { providerAmount, fee: collectFee } = collectedLog.args;
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
    collectableAt: collectableAt.toString(),
    collect: txRef,
    collectBlock: collectReceipt.blockNumber.toString(),
    providerAtRedeem: (afterRedeem - beforeRedeem).toString(),
    providerAtCollect: paid.toString(),
  };

  const sameAddress = (a: string, b: string) => getAddress(a) === getAddress(b);
  const checks: [boolean, string][] = [
    [
      sameAddress(heldLog.args.payer, buyer.address) &&
        heldLog.args.seq === voucher.seq &&
        sameAddress(heldLog.args.provider, provider) &&
        heldLog.args.amount === AMOUNT,
      'PaymentHeld names this voucher (payer, seq, provider, amount)',
    ],
    [
      sameAddress(collectedLog.args.payer, buyer.address) &&
        collectedLog.args.seq === voucher.seq &&
        sameAddress(collectedLog.args.provider, provider),
      'HeldCollected names this voucher (payer, seq, provider)',
    ],
    [
      afterRedeem === beforeRedeem,
      `provider untouched at the redemption (delta ${afterRedeem - beforeRedeem})`,
    ],
    [
      paid === amount - fee,
      `provider delta at the collect ${paid} === amount − fee ${amount - fee}`,
    ],
    [
      providerAmount === paid,
      `HeldCollected.providerAmount ${providerAmount} === the provider's delta`,
    ],
    [
      providerAmount + collectFee === amount,
      `providerAmount + fee ${providerAmount + collectFee} === amount ${amount}`,
    ],
    [amount === AMOUNT, `event amount ${amount} === voucher amount ${AMOUNT}`],
    [getAddress(payer) === buyer.address, 'event payer is the scripted buyer'],
    [getAddress(redeemed.args.provider) === provider, 'event provider is the provider'],
    [seq === voucher.seq, `event seq ${seq} === voucher seq ${voucher.seq}`],
    [
      getAddress(receipt.from) === getAddress(params.redeemer),
      `redemption sent by the configured redeemer ${params.redeemer}, i.e. the platform's redeemer key`,
    ],
    [
      getAddress(collectReceipt.from) === getAddress(params.redeemer),
      `collect sent by the configured redeemer ${params.redeemer}`,
    ],
  ];
  const failed = checks.filter(([ok]) => !ok).map(([, what]) => what);
  return failed.length > 0
    ? { outcome: 'FAILED', evidence: `not true: ${failed.join('; ')}`, unproven: null, detail }
    : {
        outcome: 'PASSED',
        evidence:
          `redeemed into hold by the platform in ${hash} (block ${receipt.blockNumber}), collected ` +
          `by the platform in ${txRef} (block ${collectReceipt.blockNumber}); provider ${provider} ` +
          `+${paid} = ${amount} − fee ${fee} in that block`,
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
