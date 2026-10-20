/// <reference types="node" />
/**
 * `yarn testnet:isolation <S4|E7|E8>` — the chain-isolation criteria as live HTTP reads against
 * booted API and MCP servers.
 *
 * ```text
 * S4  ENABLED_CHAINS listing only Solana mainnet: a devnet deposit is refused CHAIN_UNSUPPORTED
 * E7  ENABLED_CHAINS without eip155:46630: no 402 advertises it, its providers are excluded,
 *     a deposit naming it is refused CHAIN_UNSUPPORTED, GET /chains does not list it
 * E8  a buyer funded only on Solana calling a tool whose only provider settles on eip155 is
 *     refused PAYMENT_NO_SETTLEABLE_CHAIN, and no transaction reaches either chain
 * ```
 *
 * The servers are not started here: one deployment per `ENABLED_CHAINS` value has to be running
 * already, which is the point — the criterion is about what a booted platform answers. Each is
 * described in `ISOLATION_TARGETS_FILE` (kept outside the repo; it holds bearer tokens):
 *
 * ```json
 * [{
 *   "name": "solana-mainnet-only",
 *   "criteria": ["S4", "E7"],
 *   "apiUrl": "http://localhost:38081/api/v1",
 *   "mcpUrl": "http://localhost:38201/",
 *   "enabledChains": ["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"],
 *   "tool": "get_weather",
 *   "args": { "latitude": 21.03, "longitude": 105.85 },
 *   "excludedProviders": ["<provider org id whose bindings settle only on a disabled chain>"],
 *   "buyers": [
 *     { "chainId": "eip155:46630", "token": "assay_sk_live_…", "expectCall": "PAYMENT_NO_SETTLEABLE_CHAIN" }
 *   ]
 * }]
 * ```
 *
 * Per target, for the criterion asked:
 *
 * 1. `GET /chains` lists exactly `enabledChains`.
 * 2. Every buyer whose chain is not enabled is refused `CHAIN_UNSUPPORTED` by `POST /deposits`.
 * 3. Every buyer's `tools/call`: a 402 names an enabled network and never an excluded provider;
 *    `expectCall`, when given, is the error code the call must end with.
 * 4. `ISOLATION_EVM_RPC_URL` + `ISOLATION_EVM_WATCH` (comma-separated addresses): their nonces
 *    are unchanged across the run, so nothing was submitted to eip155 on the buyer's behalf.
 *
 * Prints one `ISOLATION_RESULT {json}` line and exits 0 only on PASSED.
 */
import { readFileSync } from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPublicClient, getAddress, http } from 'viem';

interface Buyer {
  readonly chainId: string;
  readonly token: string;
  readonly expectCall?: string;
}

interface Target {
  readonly name: string;
  readonly criteria: readonly string[];
  readonly apiUrl: string;
  readonly mcpUrl: string;
  readonly enabledChains: readonly string[];
  readonly tool: string;
  readonly args: Record<string, unknown>;
  readonly excludedProviders?: readonly string[];
  readonly buyers: readonly Buyer[];
}

interface IsolationResult {
  outcome: 'PASSED' | 'FAILED' | 'NOT_RUN';
  criterion: string;
  evidence: string;
  unproven: string | null;
  failures?: readonly string[];
}

const DEPOSIT_PROBE_ATOMIC = '1000000';

async function errorCodeOf(response: Response): Promise<string | null> {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string };
  } | null;
  return body?.error?.code ?? null;
}

async function listedChains(apiUrl: string): Promise<string[]> {
  const response = await fetch(`${apiUrl}/chains`);
  const body = (await response.json()) as { data: unknown };
  const data = body.data as
    | Array<{ chainId: string }>
    | { items?: Array<{ chainId: string }>; chains?: Array<{ chainId: string }> };
  const rows = Array.isArray(data) ? data : (data.items ?? data.chains ?? []);
  return rows.map((row) => row.chainId).sort();
}

async function callTool(
  target: Target,
  buyer: Buyer,
): Promise<{ code: string | null; network: string | null; providerId: string | null }> {
  const client = new Client({ name: 'chain-isolation', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(target.mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${buyer.token}` } },
    }),
  );
  try {
    const result = await client.callTool({ name: target.tool, arguments: target.args });
    const meta = (result._meta ?? {}) as Record<string, Record<string, unknown> | undefined>;
    const requirement = meta['x402/paymentRequired'];
    return {
      code: (meta['assay/error']?.code as string | undefined) ?? null,
      network: (requirement?.network as string | undefined) ?? null,
      providerId: (requirement?.providerId as string | undefined) ?? null,
    };
  } finally {
    await client.close();
  }
}

async function nonces(): Promise<Map<string, number> | null> {
  const rpcUrl = process.env.ISOLATION_EVM_RPC_URL;
  const watch = process.env.ISOLATION_EVM_WATCH;
  if (!rpcUrl || !watch) return null;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const out = new Map<string, number>();
  for (const address of watch.split(',').map((a) => getAddress(a.trim()))) {
    out.set(address, await client.getTransactionCount({ address, blockTag: 'pending' }));
  }
  return out;
}

async function checkTarget(target: Target, failures: string[], notes: string[]): Promise<void> {
  const enabled = [...target.enabledChains].sort();

  const listed = await listedChains(target.apiUrl);
  if (JSON.stringify(listed) !== JSON.stringify(enabled)) {
    failures.push(
      `${target.name}: GET /chains lists ${listed.join(',')}, expected ${enabled.join(',')}`,
    );
  } else {
    notes.push(`${target.name}: GET /chains = ${listed.join(',')}`);
  }

  for (const buyer of target.buyers) {
    if (!enabled.includes(buyer.chainId)) {
      const response = await fetch(`${target.apiUrl}/deposits`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${buyer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ amount: DEPOSIT_PROBE_ATOMIC, chainId: buyer.chainId }),
      });
      const code = await errorCodeOf(response);
      if (code !== 'CHAIN_UNSUPPORTED') {
        failures.push(
          `${target.name}: deposit on ${buyer.chainId} answered ${response.status} ${code}`,
        );
      } else {
        notes.push(`${target.name}: deposit on ${buyer.chainId} refused CHAIN_UNSUPPORTED`);
      }
    }

    const call = await callTool(target, buyer);
    if (call.network !== null && !enabled.includes(call.network)) {
      failures.push(`${target.name}: a 402 advertised the disabled network ${call.network}`);
    }
    if (call.providerId !== null && (target.excludedProviders ?? []).includes(call.providerId)) {
      failures.push(`${target.name}: routed to excluded provider ${call.providerId}`);
    }
    if (buyer.expectCall && call.code !== buyer.expectCall) {
      failures.push(
        `${target.name}: ${buyer.chainId} buyer's ${target.tool} ended ${call.code}, expected ${buyer.expectCall}`,
      );
    }
    notes.push(
      `${target.name}: ${buyer.chainId} buyer's ${target.tool} → ${call.code}` +
        (call.network ? ` on ${call.network} via ${call.providerId}` : ''),
    );
  }
}

async function run(criterion: string): Promise<IsolationResult> {
  const file = process.env.ISOLATION_TARGETS_FILE;
  if (!file) {
    return {
      outcome: 'NOT_RUN',
      criterion,
      evidence: 'ISOLATION_TARGETS_FILE is not set',
      unproven:
        'no booted API/MCP pair was probed; describe one per ENABLED_CHAINS value and re-run',
    };
  }
  const targets = (JSON.parse(readFileSync(file, 'utf8')) as Target[]).filter((t) =>
    t.criteria.includes(criterion),
  );
  if (targets.length === 0) {
    return {
      outcome: 'NOT_RUN',
      criterion,
      evidence: `no target in ${file} is tagged ${criterion}`,
      unproven: `nothing was probed for ${criterion}`,
    };
  }

  const failures: string[] = [];
  const notes: string[] = [];
  const before = await nonces();
  for (const target of targets) await checkTarget(target, failures, notes);
  const after = await nonces();

  if (before && after) {
    for (const [address, nonce] of before) {
      if (after.get(address) !== nonce) {
        failures.push(`nonce of ${address} moved ${nonce} → ${after.get(address)}`);
      }
    }
    notes.push(`eip155 nonces unchanged for ${[...before.keys()].join(',')}`);
  }

  return {
    outcome: failures.length === 0 ? 'PASSED' : 'FAILED',
    criterion,
    evidence: (failures.length ? failures : notes).join('; '),
    unproven:
      before && after
        ? null
        : 'ISOLATION_EVM_RPC_URL / ISOLATION_EVM_WATCH unset: no eip155 nonce was compared',
    ...(failures.length ? { failures } : {}),
  };
}

const criterion = process.argv[2] ?? '';
run(criterion)
  .then((result) => {
    console.log(`ISOLATION_RESULT ${JSON.stringify(result)}`);
    process.exit(result.outcome === 'PASSED' ? 0 : 1);
  })
  .catch((error: unknown) => {
    const result: IsolationResult = {
      outcome: 'FAILED',
      criterion,
      evidence: (error as Error).stack ?? String(error),
      unproven: null,
    };
    console.log(`ISOLATION_RESULT ${JSON.stringify(result)}`);
    process.exit(1);
  });
