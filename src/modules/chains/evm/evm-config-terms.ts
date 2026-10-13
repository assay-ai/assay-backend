import { getAddress } from 'viem';

import { X402_CONFIG_ABI } from './abi/x402.abi';

/**
 * What `X402Config` says about disputes, the pause and the slash delay
 * (assay-evm D-19), read live.
 *
 * The backend assumes the upgraded contracts (owner decision): there is no
 * "old Config" branch. Every read failure is a plain RPC error and is thrown,
 * so the caller retries; nothing is ever assumed (in particular not a 72 h
 * delay). The one compatibility check left is {@link checkConfigUpgraded}, a
 * boot-time log line.
 */
export interface EvmConfigTerms {
  readonly paused: boolean;
  /** `X402Config.arbiter()`, or `null` when it reads as the zero address. */
  readonly arbiter: `0x${string}` | null;
  /** The delay a proposal made NOW freezes into its `executableAt`, in seconds. */
  readonly slashDelaySeconds: number;
}

export interface EvmConfigTermsClient {
  readContract(args: {
    address: `0x${string}`;
    abi: unknown;
    functionName: string;
    args: readonly unknown[];
  }): Promise<unknown>;
}

export async function readConfigTerms(
  client: EvmConfigTermsClient,
  config: `0x${string}`,
): Promise<EvmConfigTerms> {
  const read = (functionName: string) =>
    client.readContract({ address: config, abi: X402_CONFIG_ABI, functionName, args: [] });

  const [paused, delay, arbiter] = await Promise.all([
    read('paused') as Promise<boolean>,
    read('slashDelaySeconds') as Promise<bigint>,
    read('arbiter') as Promise<`0x${string}`>,
  ]);
  return {
    paused: Boolean(paused),
    arbiter: !arbiter || BigInt(arbiter) === 0n ? null : getAddress(arbiter),
    slashDelaySeconds: Number(delay),
  };
}

/**
 * The one boot-time sanity check: a Config that does not answer `arbiter()`
 * has not been upgraded, and nothing about disputes, the on-chain blocklist or
 * the settable delay will work against it. Logged, never thrown — the process
 * still serves everything else.
 */
export async function checkConfigUpgraded(
  client: EvmConfigTermsClient,
  config: `0x${string}`,
  chainId: string,
  log: { error(message: string): void },
): Promise<boolean> {
  try {
    await client.readContract({
      address: config,
      abi: X402_CONFIG_ABI,
      functionName: 'arbiter',
      args: [],
    });
    return true;
  } catch (error) {
    log.error(
      `contracts not upgraded: X402Config ${config} on ${chainId} does not answer arbiter(); ` +
        `the backend requires the dispute upgrade (assay-evm D-19) ` +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
    return false;
  }
}
