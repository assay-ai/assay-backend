/**
 * `yarn testnet:e5 <request|withdraw|auto>` — acceptance criterion E5 against the LIVE `eip155:46630`
 * deployment.
 *
 * > A buyer withdraws with **zero** ETH after the relayer's bounded gas top-up.
 *
 * Two phases, because `AssayEscrow` holds a requested withdrawal for `WITHDRAW_DELAY_SECONDS`
 * (one hour) and a process that sleeps through it proves nothing a second invocation does not.
 *
 * ## Who plays which part
 *
 * - **The buyer** is a scripted identity (`TESTNET_E5_BUYER_KEY`) that must hold **0 wei** and
 *   never receives ETH from this script. It only signs: the EIP-712 `RequestWithdraw`, and later
 *   the `withdraw()` transaction the platform built for it.
 * - **The funder** (`TESTNET_E5_FUNDER_KEY`) credits the buyer's escrow with `depositFor`, the
 *   way an on-ramp would. A buyer with no ETH cannot `approve` or `deposit` for itself.
 * - **The platform is the platform's own code**, resolved out of the real Nest graph:
 *   `WithdrawalService.submitRelayedIntent` sends `requestWithdrawBySig` through the configured
 *   relayer, and `WithdrawalService.buildIntent` builds the `withdraw()` and runs the gas grant.
 *
 * ## What is asserted
 *
 * `request`: the buyer holds 0 wei before and after, and the chain records the withdrawal.
 * `withdraw`: the buyer holds 0 wei until the grant, the grant is `GRANTED`, the buyer's own
 * `withdraw()` succeeds on the granted ETH alone, and its token balance rises by exactly the
 * requested amount.
 *
 * Prints one `E5_RESULT {json}` line and exits 0 only on PASSED.
 */
import { randomUUID } from 'node:crypto';

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ASSAY_ESCROW_ABI } from '@modules/chains/evm/abi/assay.abi';
import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { requestWithdrawTypedData } from '@modules/chains/evm/eip712/escrow-control';
import { ChainId, toAccountId, toAssetId } from '@modules/chains/ports/caip.types';
import { EscrowIntentKind } from '@modules/settlement/ports/escrow-intent-builder.port';
import { WithdrawalService } from '@modules/settlement/services/withdrawal.service';

import { bootAppContext } from '../devnet/lib/app-context';

const CHAIN_ID = 'eip155:46630' as ChainId;
/** Five tokens. Evidence, not load. */
const AMOUNT = 5_000_000n;
const SIGNATURE_LIFETIME_SECONDS = 600n;

const TOKEN_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  // Testnet mock token: permissionless mint.
  'function mint(address to, uint256 amount)',
]);

interface E5Result {
  outcome: 'PASSED' | 'FAILED' | 'NOT_RUN';
  phase: string;
  evidence: string;
  unproven: string | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(phase: string): Promise<E5Result> {
  const rpcUrl = (JSON.parse(required('EVM_RPC_URLS')) as Record<string, string>)[CHAIN_ID];
  const deployment = (
    JSON.parse(required('EVM_DEPLOYMENTS')) as Record<string, Record<string, string>>
  )[CHAIN_ID];
  if (!rpcUrl || !deployment) throw new Error(`EVM_RPC_URLS / EVM_DEPLOYMENTS lack ${CHAIN_ID}`);

  const buyer = privateKeyToAccount(required('TESTNET_E5_BUYER_KEY') as `0x${string}`);
  const escrow = getAddress(deployment.escrow);
  const token = getAddress(deployment.asset);
  const account = toAccountId(CHAIN_ID, buyer.address);
  const asset = toAssetId(CHAIN_ID, 'erc20', token);
  // Any stable id: the gas grant ledger and the rate limiter key on it, nothing joins it.
  const organizationId = process.env.TESTNET_E5_ORGANIZATION_ID ?? randomUUID();

  const chain = defineChain({
    id: 46630,
    name: 'Robinhood Chain testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  const readEscrow = async () =>
    (await pub.readContract({
      address: escrow,
      abi: ASSAY_ESCROW_ABI,
      functionName: 'escrowOf',
      args: [buyer.address],
    })) as {
      balance: bigint;
      authNonce: bigint;
      withdrawRequested: bigint;
      withdrawAvailableAt: bigint;
    };
  const buyerWei = () => pub.getBalance({ address: buyer.address });

  // `auto` reads the chain and picks the step that can run now, which is what the acceptance
  // suite calls: one invocation either opens the request or completes the exit.
  let step = phase;
  if (phase === 'auto') {
    const state = await readEscrow();
    const now = (await pub.getBlock()).timestamp;
    if (state.withdrawRequested === 0n) {
      if ((await buyerWei()) !== 0n) {
        return {
          outcome: 'NOT_RUN',
          phase,
          evidence: `the scripted buyer ${buyer.address} holds ETH and has no withdrawal open`,
          unproven:
            'a zero-ETH exit was not exercised in this invocation; set TESTNET_E5_BUYER_KEY to a ' +
            'fresh key that has never held ETH and re-run',
        };
      }
      step = 'request';
    } else if (now < state.withdrawAvailableAt) {
      return {
        outcome: 'NOT_RUN',
        phase,
        evidence: `a withdrawal is open and matures at ${state.withdrawAvailableAt} (chain time ${now})`,
        unproven: 'the zero-ETH withdraw itself; re-run once the request has matured',
      };
    } else {
      step = 'withdraw';
    }
  }

  if ((await buyerWei()) !== 0n && step === 'request') {
    return {
      outcome: 'FAILED',
      phase,
      evidence: `the scripted buyer ${buyer.address} already holds ETH; E5 needs a zero-ETH buyer`,
      unproven: null,
    };
  }

  const app = await bootAppContext();
  const withdrawals = app.get(WithdrawalService, { strict: false });

  if (step === 'request') {
    // ── 1. A third party credits the buyer's escrow ────────────────────────
    const funder = privateKeyToAccount(required('TESTNET_E5_FUNDER_KEY') as `0x${string}`);
    const fw = createWalletClient({ account: funder, chain, transport: http(rpcUrl) });
    const send = async (label: string, request: Parameters<typeof fw.writeContract>[0]) => {
      const hash = await fw.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
      console.log(`  ${label}: ${hash}`);
    };
    const held = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [funder.address],
    });
    if (held < AMOUNT) {
      await send('funder mint', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'mint',
        args: [funder.address, AMOUNT],
        chain,
        account: funder,
      });
    }
    const allowance = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'allowance',
      args: [funder.address, escrow],
    });
    if (allowance < AMOUNT) {
      await send('funder approve', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'approve',
        args: [escrow, AMOUNT],
        chain,
        account: funder,
      });
    }
    await send('funder depositFor', {
      address: escrow,
      abi: ASSAY_ESCROW_ABI,
      functionName: 'depositFor',
      args: [buyer.address, AMOUNT],
      chain,
      account: funder,
    });

    // ── 2. The buyer signs, the platform relays ────────────────────────────
    const before = await readEscrow();
    const latest = await pub.getBlock();
    const message = {
      buyer: buyer.address,
      amount: AMOUNT,
      nonce: before.authNonce,
      deadline: latest.timestamp + SIGNATURE_LIFETIME_SECONDS,
    };
    const signature = await buyer.signTypedData(
      requestWithdrawTypedData(message, evmDomain(CHAIN_ID, escrow)),
    );
    const relayed = await withdrawals.submitRelayedIntent(
      organizationId,
      account,
      asset,
      buyer.address,
      {
        kind: EscrowIntentKind.REQUEST_WITHDRAW,
        amount: message.amount,
        nonce: message.nonce,
        deadline: message.deadline,
        signature,
      },
    );

    const after = await readEscrow();
    const wei = await buyerWei();
    if (after.withdrawRequested !== AMOUNT || wei !== 0n) {
      return {
        outcome: 'FAILED',
        phase,
        evidence: `withdrawRequested=${after.withdrawRequested}, buyer wei=${wei}`,
        unproven: null,
      };
    }
    return {
      // Under `auto` the criterion is not met until the exit completes.
      outcome: phase === 'auto' ? 'NOT_RUN' : 'PASSED',
      phase,
      evidence:
        `requestWithdrawBySig relayed by the platform in ${relayed.submission.transactionHash}; ` +
        `buyer ${buyer.address} still holds 0 wei; matures at ${after.withdrawAvailableAt}`,
      unproven: 'the withdraw itself — run the `withdraw` phase once it has matured',
    };
  }

  if (step === 'withdraw') {
    const before = await readEscrow();
    const weiBefore = await buyerWei();
    if (weiBefore !== 0n) {
      return {
        outcome: 'FAILED',
        phase,
        evidence: `buyer holds ${weiBefore} wei before the grant; E5 needs it at zero`,
        unproven: null,
      };
    }
    const tokensBefore = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [buyer.address],
    });

    // ── 3. The platform builds the exit and grants its gas ─────────────────
    const result = await withdrawals.buildIntent(organizationId, account, asset, {
      kind: EscrowIntentKind.WITHDRAW,
      amount: null,
      limits: null,
      destination: null,
    });
    if (result.gasGrant?.kind !== 'GRANTED') {
      return {
        outcome: 'FAILED',
        phase,
        evidence: `the gas grant answered ${JSON.stringify(result.gasGrant)}`,
        unproven: null,
      };
    }
    const tx = result.transaction;
    if (tx.namespace !== 'eip155' || tx.kind !== 'transaction') {
      throw new Error(`expected an eip155 transaction, got ${tx.namespace}/${tx.kind}`);
    }
    const granted = await buyerWei();

    // ── 4. The buyer sends its own withdraw() on the granted ETH alone ─────
    const signed = await buyer.signTransaction({
      type: 'eip1559',
      chainId: 46630,
      to: getAddress(tx.to),
      data: tx.data as `0x${string}`,
      value: BigInt(tx.value),
      nonce: Number(tx.nonce),
      gas: BigInt(tx.gasLimit),
      maxFeePerGas: BigInt(tx.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas),
    });
    const hash = await pub.sendRawTransaction({ serializedTransaction: signed });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    const tokensAfter = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [buyer.address],
    });
    const after = await readEscrow();

    const paid = tokensAfter - tokensBefore;
    if (receipt.status !== 'success' || paid !== before.withdrawRequested) {
      return {
        outcome: 'FAILED',
        phase,
        evidence: `withdraw ${hash} status=${receipt.status}, paid ${paid} of ${before.withdrawRequested}`,
        unproven: null,
      };
    }
    return {
      outcome: 'PASSED',
      phase,
      evidence:
        `buyer ${buyer.address} held 0 wei, was granted ${granted} wei by the relayer, and ` +
        `withdrew ${paid} in ${hash} (block ${receipt.blockNumber}); escrow request now ` +
        `${after.withdrawRequested}`,
      unproven: null,
    };
  }

  throw new Error('usage: e5-zero-eth-withdraw.ts <request|withdraw|auto>');
}

const phase = process.argv[2] ?? '';
run(phase)
  .then((result) => {
    console.log(`E5_RESULT ${JSON.stringify(result)}`);
    process.exit(result.outcome === 'PASSED' ? 0 : 1);
  })
  .catch((error: unknown) => {
    const result: E5Result = {
      outcome: 'FAILED',
      phase,
      evidence: (error as Error).stack ?? String(error),
      unproven: null,
    };
    console.log(`E5_RESULT ${JSON.stringify(result)}`);
    process.exit(1);
  });
