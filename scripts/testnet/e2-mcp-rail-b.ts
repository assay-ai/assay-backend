/// <reference types="node" />
/**
 * `yarn testnet:e2-mcp` — the half of acceptance criterion E2 that `yarn testnet:e2` leaves
 * unproven: a PAID MCP call on rail B, against a DEPLOYED platform, by a buyer agent that signs
 * its own voucher.
 *
 * ```text
 *  (optional) POST /deposits + approve + signed depositFor + settle   the agent funds its escrow
 *  tools/call                         → PAYMENT_REQUIRED, _meta[x402/paymentRequired]
 *  sign the EIP-712 voucher from that requirement, and nothing else
 *  tools/call + _meta[x402/voucher]   → the result, receipt status VERIFYING
 * ```
 *
 * Redemption is NOT done here: the platform's own `VoucherRedemptionJob` redeems the voucher on
 * chain once verification settles the intent. This script prints the intent id; the redemption's
 * tx hash and the ledger rows are read off the platform afterwards.
 *
 * ## Who plays which part
 *
 * The buyer is a scripted identity holding its own key (`TESTNET_E2_BUYER_KEY`), for the reason
 * `e2-voucher-redemption.ts` gives: a Privy embedded key cannot be exported. It authenticates as
 * an agent credential (`E2_MCP_TOKEN`, `x402_sk_live_…`) whose agent's primary account is that
 * key's address. Everything the voucher binds comes from the requirement the platform answered
 * with — the script computes no hash and chooses no provider.
 *
 * ```bash
 * set -a; . path/to/e2-buyer.env; set +a
 * E2_MCP_URL=https://mcp.example.com/mcp E2_API_URL=https://api.example.com/api/v1 \
 *   E2_MCP_TOKEN=x402_sk_live_… E2_DEPOSIT_ATOMIC=5000000 yarn testnet:e2-mcp
 * ```
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseAbi,
  stringToBytes,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmDomain } from '@modules/chains/evm/eip712/domain';
import { voucherTypedData } from '@modules/chains/evm/eip712/voucher';
import { ChainId, parseAccountId } from '@modules/chains/ports/caip.types';

/**
 * The deployment under test. No default on purpose: a script that pays real (testnet) money must
 * be told which platform it is paying, rather than guessing one.
 */
const MCP_URL = requiredEndpoint('E2_MCP_URL', 'https://mcp.example.com/mcp');
const API_URL = requiredEndpoint('E2_API_URL', 'https://api.example.com/api/v1');
const RPC_URL = process.env.E2_RPC_URL ?? 'https://rpc.testnet.chain.robinhood.com';
const TOOL = process.env.E2_TOOL ?? 'get_weather';
const ARGS = JSON.parse(process.env.E2_ARGS ?? '{"latitude":21.03,"longitude":105.85}');
/** Well under the platform's 300s ceiling, so a slow retry still lands inside the window. */
const LIFETIME_SECONDS = 180;

const TOKEN_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
const ESCROW_ABI = parseAbi(['function depositFor(address buyer, uint64 amount)']);

interface VoucherRequirement {
  network: ChainId;
  payer: string;
  payTo: string;
  provider: string;
  providerId: string;
  amount: { amount: string; asset: string; decimals: number };
  resource: string;
  requestHash: string;
  seq: string;
  maxTimeoutSeconds: number;
}

function requiredEndpoint(name: string, example: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(
      `${name} is not set. Point it at the deployment under test, e.g. ${name}=${example}`,
    );
    process.exit(1);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const buyer = privateKeyToAccount(required('TESTNET_E2_BUYER_KEY') as `0x${string}`);
const token = required('E2_MCP_TOKEN');
const chain = defineChain({
  id: 46630,
  name: 'Robinhood Chain testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const wallet = createWalletClient({ account: buyer, chain, transport: http(RPC_URL) });

async function api<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as { data?: T; error?: unknown };
  if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(json.error)}`);
  return json.data as T;
}

/** The product's own deposit path, as the frontend walks it for an embedded wallet. */
async function deposit(amount: bigint): Promise<void> {
  const created = await api<{
    depositId: string;
    requirements: {
      chainId: string;
      contract: string;
      spender: string;
      buyer: string;
      asset: string;
    };
  }>('/deposits', { amount: amount.toString(), chainId: 'eip155:46630' });
  const { requirements } = created;
  if (getAddress(requirements.buyer) !== buyer.address) {
    throw new Error(`the credential's agent is ${requirements.buyer}, not ${buyer.address}`);
  }

  const allowance = await pub.readContract({
    address: getAddress(requirements.asset),
    abi: TOKEN_ABI,
    functionName: 'allowance',
    args: [buyer.address, getAddress(requirements.spender)],
  });
  if (allowance < amount) {
    const hash = await wallet.writeContract({
      address: getAddress(requirements.asset),
      abi: TOKEN_ABI,
      functionName: 'approve',
      args: [getAddress(requirements.spender), amount],
    } as never);
    await pub.waitForTransactionReceipt({ hash });
    console.log(`  approve: ${hash}`);
  }

  // Signed and NOT sent: the facilitator broadcasts it (x402 `exact`, option A).
  const request = await wallet.prepareTransactionRequest({
    to: getAddress(requirements.contract),
    data: encodeFunctionData({
      abi: ESCROW_ABI,
      functionName: 'depositFor',
      args: [buyer.address, amount],
    }),
  } as never);
  const signed = await wallet.signTransaction(request as never);
  const settled = await api<{ status: string; chainTxRef: string | null }>(
    `/deposits/${created.depositId}/settle`,
    {
      x402Version: 2,
      scheme: 'exact',
      network: requirements.chainId,
      payload: { transaction: signed },
    },
  );
  console.log(`  deposit ${created.depositId}: ${settled.status} ${settled.chainTxRef ?? ''}`);
}

async function signVoucher(requirement: VoucherRequirement) {
  const now = Math.floor(Date.now() / 1000);
  const voucher = {
    payer: requirement.payer,
    payTo: requirement.payTo,
    provider: requirement.provider,
    amount: requirement.amount,
    resource: requirement.resource,
    requestHash: requirement.requestHash,
    seq: requirement.seq,
    issuedAt: now,
    expiresAt: now + Math.min(LIFETIME_SECONDS, requirement.maxTimeoutSeconds),
  };
  if (getAddress(parseAccountId(voucher.payer).address) !== buyer.address) {
    throw new Error(`the requirement names payer ${voucher.payer}, not this key`);
  }

  const signature = await buyer.signTypedData(
    voucherTypedData(
      {
        payer: buyer.address,
        provider: getAddress(parseAccountId(voucher.provider).address),
        amount: BigInt(voucher.amount.amount),
        resourceHash: keccak256(stringToBytes(voucher.resource)),
        requestHash: `0x${voucher.requestHash.replace(/^sha256:/, '')}`,
        seq: BigInt(voucher.seq),
        issuedAt: BigInt(voucher.issuedAt),
        expiresAt: BigInt(voucher.expiresAt),
      },
      evmDomain(requirement.network, getAddress(parseAccountId(voucher.payTo).address)),
    ),
  );
  return { voucher, signature, providerId: requirement.providerId };
}

async function run(): Promise<void> {
  const depositAtomic = process.env.E2_DEPOSIT_ATOMIC;
  if (depositAtomic) await deposit(BigInt(depositAtomic));

  const client = new Client({ name: 'testnet-e2-mcp', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );

  const refused = (await client.callTool({ name: TOOL, arguments: ARGS })) as CallToolResult;
  const requirement = refused._meta?.['x402/paymentRequired'] as VoucherRequirement | undefined;
  if (!requirement) {
    throw new Error(`expected PAYMENT_REQUIRED, got ${JSON.stringify(refused._meta ?? refused)}`);
  }
  console.log(
    `  requirement: seq ${requirement.seq} · ${requirement.amount.amount} → provider ` +
      `${requirement.providerId} (${requirement.provider})`,
  );

  const paid = (await client.callTool({
    name: TOOL,
    arguments: ARGS,
    _meta: { 'x402/voucher': await signVoucher(requirement) },
  })) as CallToolResult;
  await client.close();

  console.log(
    `E2_MCP_RESULT ${JSON.stringify({
      isError: paid.isError ?? false,
      receipt: paid._meta?.['x402/receipt'] ?? null,
      error: paid._meta?.['x402/error'] ?? null,
      result: paid.structuredContent ?? null,
    })}`,
  );
  process.exit(paid.isError ? 1 : 0);
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
