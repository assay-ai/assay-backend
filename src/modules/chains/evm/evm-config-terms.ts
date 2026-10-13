import { getAddress } from 'viem';

import { X402_CONFIG_ABI } from './abi/x402.abi';
import { EVM_CONSTANTS } from './evm.constants';
import { isRevert } from './evm-voucher-authority';

/**
 * What `X402Config` says about the dispute upgrade (assay-evm D-19), read live.
 *
 * ## How an old Config is told apart
 *
 * The upgrade is not deployed everywhere at once, and the backend must serve
 * both sides of it with no flag to flip. `slashDelaySeconds()` is the probe:
 * a Config that predates the upgrade has no such function and reverts with
 * empty data, which is exactly what `isRevert` recognises. A TRANSPORT error
 * (the node did not answer) is rethrown, never read as "old": mistaking an
 * outage for an old Config would quietly switch off the blocklist checks.
 *
 * On an old Config the delay is {@link EVM_CONSTANTS.PRE_DISPUTE_SLASH_DELAY_SECONDS}
 * — that contract's own compile-time constant, not an assumption — there is no
 * arbiter and no blocklist, and the pause closes only deposits, redemption and
 * the slash doors.
 */
export interface EvmConfigTerms {
  /** True when the Config carries the dispute upgrade's surface. */
  readonly upgraded: boolean;
  readonly paused: boolean;
  /** `X402Config.arbiter()`, or `null` for none (and on an old Config). */
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
  const read = (functionName: string, args: readonly unknown[] = []) =>
    client.readContract({ address: config, abi: X402_CONFIG_ABI, functionName, args });

  const [paused, delay] = await Promise.all([
    read('paused') as Promise<boolean>,
    (read('slashDelaySeconds') as Promise<bigint>).catch((error: unknown) => {
      if (isRevert(error)) return null;
      throw error;
    }),
  ]);
  if (delay === null) {
    return {
      upgraded: false,
      paused: Boolean(paused),
      arbiter: null,
      slashDelaySeconds: EVM_CONSTANTS.PRE_DISPUTE_SLASH_DELAY_SECONDS,
    };
  }
  const arbiter = (await read('arbiter')) as `0x${string}`;
  return {
    upgraded: true,
    paused: Boolean(paused),
    arbiter: !arbiter || BigInt(arbiter) === 0n ? null : getAddress(arbiter),
    slashDelaySeconds: Number(delay),
  };
}
