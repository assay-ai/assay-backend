/**
 * `yarn testnet:e6 <deposit|reconcile>` — acceptance criterion E6 against the LIVE `eip155:46630`
 * deployment.
 *
 * > The reconciler reports a clean run against a live 46630 deployment.
 *
 * A clean run is only evidence if the ledger and the chain were brought into agreement by the
 * platform's own paths, so the money goes in the way a buyer's does:
 *
 * - `deposit`: `DepositService.createDeposit` opens the intent, the scripted buyer
 *   (`TESTNET_E6_BUYER_KEY`, which pays its own gas) sends `approve` + `depositFor` itself, and
 *   `DepositService.settleDepositByBroadcast` reads that transaction off the chain.
 * - `reconcile`: `DepositFinalityService.promotePendingDeposits` credits the ledger once the
 *   deposit is final, then `ReconciliationService.reconcile` runs against the live escrow and
 *   must report `OK` with no findings.
 *
 * The escrow must hold nothing the ledger did not record — money deposited directly, outside
 * the platform, is a real surplus and the reconciler is right to report it. Prints one
 * `E6_RESULT {json}` line and exits 0 only on PASSED.
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

import { X402_ESCROW_ABI } from '@modules/chains/evm/abi/x402.abi';
import { ChainId, toAccountId, toAssetId } from '@modules/chains/ports/caip.types';
import { TxRef } from '@modules/chains/ports/x402.types';
import { DepositFinalityService } from '@modules/payment/services/deposit-finality.service';
import { LedgerService } from '@modules/ledger/services/ledger.service';
import { DepositService } from '@modules/payment/services/deposit.service';
import { ReconciliationSeverity } from '@modules/settlement/ports/reconciliation.types';
import { ReconciliationService } from '@modules/settlement/services/reconciliation.service';
import { MoneyUtil } from '@shared/utils/money.util';

import { bootAppContext } from '../devnet/lib/app-context';

const CHAIN_ID = 'eip155:46630' as ChainId;
/** Ten tokens. */
const AMOUNT = 10_000_000n;
const FINALITY_POLL_MS = 15_000;
const FINALITY_TIMEOUT_MS = 30 * 60_000;

const TOKEN_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  // Testnet mock token: permissionless mint.
  'function mint(address to, uint256 amount)',
]);

interface E6Result {
  outcome: 'PASSED' | 'FAILED';
  phase: string;
  evidence: string;
  unproven: string | null;
  detail?: Record<string, unknown>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

async function run(phase: string): Promise<E6Result> {
  const rpcUrl = (JSON.parse(required('EVM_RPC_URLS')) as Record<string, string>)[CHAIN_ID];
  const deployment = (
    JSON.parse(required('EVM_DEPLOYMENTS')) as Record<string, Record<string, string>>
  )[CHAIN_ID];
  if (!rpcUrl || !deployment) throw new Error(`EVM_RPC_URLS / EVM_DEPLOYMENTS lack ${CHAIN_ID}`);

  const buyer = privateKeyToAccount(required('TESTNET_E6_BUYER_KEY') as `0x${string}`);
  const organizationId = required('TESTNET_E6_ORGANIZATION_ID');
  const escrow = getAddress(deployment.escrow);
  const token = getAddress(deployment.asset);
  const account = toAccountId(CHAIN_ID, buyer.address);
  const asset = toAssetId(CHAIN_ID, 'erc20', token);

  const chain = defineChain({
    id: 46630,
    name: 'Robinhood Chain testnet',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });

  const app = await bootAppContext();
  // Ledger entries are buffered and written in batches. A script that exits without flushing
  // loses them: the intent reads SETTLED and the journal has nothing for finality to confirm.
  const ledger = app.get(LedgerService, { strict: false });

  if (phase === 'deposit') {
    const deposits = app.get(DepositService, { strict: false });
    const wallet = createWalletClient({ account: buyer, chain, transport: http(rpcUrl) });
    const send = async (label: string, request: Parameters<typeof wallet.writeContract>[0]) => {
      const hash = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
      console.log(`  ${label}: ${hash}`);
      return hash;
    };

    // ── 1. The platform opens the intent ──────────────────────────────────
    const { intent } = await deposits.createDeposit({
      organizationId,
      agentId: randomUUID(),
      agentAccount: account,
      chainId: CHAIN_ID,
      amount: MoneyUtil.of(AMOUNT, asset, 6),
    });
    console.log(`  deposit intent ${intent.id} (${intent.status})`);

    // ── 2. The buyer pays, from its own wallet ────────────────────────────
    const held = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'balanceOf',
      args: [buyer.address],
    });
    if (held < AMOUNT) {
      await send('buyer mint', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'mint',
        args: [buyer.address, AMOUNT],
        chain,
        account: buyer,
      });
    }
    const allowance = await pub.readContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: 'allowance',
      args: [buyer.address, escrow],
    });
    if (allowance < AMOUNT) {
      await send('buyer approve', {
        address: token,
        abi: TOKEN_ABI,
        functionName: 'approve',
        args: [escrow, AMOUNT],
        chain,
        account: buyer,
      });
    }
    const hash = await send('buyer depositFor', {
      address: escrow,
      abi: X402_ESCROW_ABI,
      functionName: 'depositFor',
      args: [buyer.address, AMOUNT],
      chain,
      account: buyer,
    });

    // ── 3. The platform reads the buyer's transaction off the chain ───────
    const settled = await deposits.settleDepositByBroadcast(
      organizationId,
      intent.id,
      hash as TxRef,
    );
    await ledger.flush();
    if (settled.status !== 'SETTLED') {
      return {
        outcome: 'FAILED',
        phase,
        evidence: `intent ${intent.id} is ${settled.status} after settleDepositByBroadcast`,
        unproven: null,
      };
    }
    return {
      outcome: 'PASSED',
      phase,
      evidence: `intent ${intent.id} SETTLED from the buyer's own ${hash}`,
      unproven: 'the ledger credit and the reconciliation — run the `reconcile` phase',
    };
  }

  if (phase === 'reconcile') {
    const finality = app.get(DepositFinalityService, { strict: false });
    const reconciliation = app.get(ReconciliationService, { strict: false });

    // ── 4. Finality credits the ledger ────────────────────────────────────
    const deadline = Date.now() + FINALITY_TIMEOUT_MS;
    let promoted = 0;
    for (;;) {
      const summary = await finality.promotePendingDeposits(50);
      await ledger.flush();
      console.log(`  finality pass: ${json(summary)}`);
      promoted += summary.confirmed;
      if (summary.rejected > 0) {
        return {
          outcome: 'FAILED',
          phase,
          evidence: `finality rejected ${summary.rejected} deposit(s): ${json(summary)}`,
          unproven: null,
        };
      }
      if (promoted > 0 && summary.skipped === 0) break;
      if (Date.now() > deadline) {
        return {
          outcome: 'FAILED',
          phase,
          evidence: `no deposit reached finality within ${FINALITY_TIMEOUT_MS / 60_000} min`,
          unproven: null,
        };
      }
      await new Promise((resolve) => setTimeout(resolve, FINALITY_POLL_MS));
    }

    // ── 5. The reconciler, against the live escrow ────────────────────────
    const report = await reconciliation.reconcile(asset);
    const evidence =
      `severity ${report.severity}, ${report.findings.length} finding(s); vault ` +
      `${report.vault} holds ${report.vaultBalance?.amount}, liabilities ` +
      `${report.totalLiabilitiesAtomic}, difference ${report.differenceAtomic}, ` +
      `${report.escrowAccounts} escrow account(s) read`;
    if (report.severity !== ReconciliationSeverity.OK || report.findings.length > 0) {
      return {
        outcome: 'FAILED',
        phase,
        evidence,
        unproven: null,
        detail: { findings: report.findings },
      };
    }
    return { outcome: 'PASSED', phase, evidence, unproven: null };
  }

  throw new Error('usage: e6-reconcile.ts <deposit|reconcile>');
}

const phase = process.argv[2] ?? '';
run(phase)
  .then((result) => {
    console.log(`E6_RESULT ${json(result)}`);
    process.exit(result.outcome === 'PASSED' ? 0 : 1);
  })
  .catch((error: unknown) => {
    const result: E6Result = {
      outcome: 'FAILED',
      phase,
      evidence: (error as Error).stack ?? String(error),
      unproven: null,
    };
    console.log(`E6_RESULT ${json(result)}`);
    process.exit(1);
  });
