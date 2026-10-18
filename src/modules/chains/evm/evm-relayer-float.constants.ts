import { ChainErrors } from '../errors/chains.errors';

/**
 * ONE mark, read by both the monitor and the gas grant's
 * `GasGrantRefusal.RELAYER_FLOAT_LOW` check.
 *
 * `evm-gas-grant.service.ts` re-exports this symbol as
 * `EVM_RELAYER_FLOAT_LOW_WATER_ENV` rather than spelling the string a second
 * time, and `evm-relayer-float.spec.ts` asserts the two are the same value. If
 * those were two config keys they WOULD drift, and the failure is silent in the
 * worst direction: the grant keeps paying out below a mark nobody is watching,
 * or the monitor pages about a level the grant is happily spending through.
 */
export const EVM_RELAYER_FLOAT_LOW_WEI = 'EVM_RELAYER_FLOAT_LOW_WEI';
export const EVM_RELAYER_FLOAT_CRITICAL_WEI = 'EVM_RELAYER_FLOAT_CRITICAL_WEI';

/** Every five minutes, on the second — the reconciler's own grain. */
export const EVM_RELAYER_FLOAT_CRON = '0 */5 * * * *';

/** DI token for {@link EvmRelayerFloatMarks}. */
export const EVM_RELAYER_FLOAT_MARKS = 'EVM_RELAYER_FLOAT_MARKS';

export const EVM_RELAYER_FLOAT_ALERTS = {
  LOW: 'evm_relayer_float_low',
  CRITICAL: 'evm_relayer_float_critical',
  UNREADABLE: 'evm_relayer_float_unreadable',
  /**
   * There is no relayer key for this chain, so there is no float and nothing
   * to read.
   *
   * **Separate from {@link EVM_RELAYER_FLOAT_ALERTS.UNREADABLE} on purpose.**
   * Both used to be `UNREADABLE`, and the two are opposite incidents: an
   * unreadable balance sends somebody to the RPC node, and a missing key sends
   * them to the deployment's configuration. Measured on a live scheduler
   * against a keyless deployment, the page read *"The EVM relayer's ETH float
   * could not be read"* with no error the operator could act on — the wrong
   * incident, at the grain this file's own `UNREADABLE` comment says it exists
   * to avoid.
   *
   * And sharing the name costs more than the wrong words. `SuppressingAlertSink`
   * keys on `name:dedupeKey`, so the two conditions shared one silence window:
   * in the same measured run, an RPC failure at 00:15 claimed
   * `alert:suppress:evm_relayer_float_unreadable:eip155:46630` for an hour, and
   * the keyless scheduler's 00:50 alert was suppressed by it — a second,
   * unrelated incident with **nothing** reaching a human. One name, two
   * incidents, and either can silence the other for an hour.
   */
  NO_RELAYER: 'evm_relayer_float_no_relayer',
} as const;

/** Which of the two sending keys a float reading or alert is about. */
export type EvmSendingKey = 'relayer' | 'redeemer';

/**
 * The alert dedupe key for one key's float on one chain. The relayer keeps the
 * bare chain id it always had; the redeemer's is suffixed, so the two floats
 * are two suppression buckets — one key running dry must not silence the
 * other's page. Shared by `EvmRelayer` and `EvmRelayerFloatMonitor`, which
 * emit the same alert for the same condition.
 */
export function floatDedupeKey(chainId: string, key: EvmSendingKey): string {
  return key === 'relayer' ? chainId : `${chainId}:redeemer`;
}

export interface EvmRelayerFloatMarks {
  readonly lowWei: bigint;
  readonly criticalWei: bigint;
  /**
   * `EVM_RELAYER_GAS_GRANT_MAX_WEI`, the ceiling above which the grant refuses.
   *
   * It is here rather than in the grant's own caps because `withdrawsRemaining`
   * is computed against it — see {@link EvmRelayerFloatMonitor}.
   */
  readonly perGrantMaxWei: bigint;
}

const DECIMAL_WEI = /^[0-9]+$/;

/**
 * The two marks and the grant cap, with **no defaults**.
 *
 * An unwatched float is worse than a process that refuses to start: the grant,
 * relayed buyer requests and slash sends spend the relayer's, redemptions spend
 * the redeemer's (the monitor watches both against these marks), and the first
 * symptom of an unset mark is a request nobody could send. Same rule and same reason as
 * `parseGasGrantCaps`, which refuses the same way one file over.
 *
 * No error message quotes the value it failed to parse (`docs/architecture.md`
 * §"Signing Keys" rule 6) — the habit is the point.
 */
export function parseFloatMarks(
  lowWei: string | undefined,
  criticalWei: string | undefined,
  perGrantMaxWei: string | undefined,
): EvmRelayerFloatMarks {
  const marks = {
    lowWei: positiveWei(lowWei, EVM_RELAYER_FLOAT_LOW_WEI),
    criticalWei: positiveWei(criticalWei, EVM_RELAYER_FLOAT_CRITICAL_WEI),
    perGrantMaxWei: positiveWei(perGrantMaxWei, 'EVM_RELAYER_GAS_GRANT_MAX_WEI'),
  };

  // Equal marks are not "both fire at once" — `LOW` is only ever reported when
  // `CRITICAL` did not, so a critical at or above low means the WARN tier is
  // unreachable and nobody is told during working hours.
  if (marks.criticalWei >= marks.lowWei) {
    throw ChainErrors.configValueInvalid({
      variable: EVM_RELAYER_FLOAT_CRITICAL_WEI,
      accepted:
        `a whole number of wei that must be below ${EVM_RELAYER_FLOAT_LOW_WEI}; at or above ` +
        'it the WARN tier is unreachable and the first anyone hears is the page',
    });
  }

  return marks;
}

function positiveWei(value: string | undefined, variable: string): bigint {
  if (value === undefined || !DECIMAL_WEI.test(value)) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a positive whole number of wei, in decimal, with no unit and no 0x prefix',
    });
  }

  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw ChainErrors.configValueInvalid({
      variable,
      accepted: 'a positive whole number of wei — zero disables the check without saying so',
    });
  }

  return parsed;
}
