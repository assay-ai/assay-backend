/**
 * Reading the settlement program's own refusal out of whatever the RPC handed
 * back.
 *
 * Shared by `SolanaSlashExecutor` and `SolanaVoucherRedeemer`, and shared
 * rather than duplicated for the same reason `ed25519-precompile.ts` is: three
 * different reply shapes reach here, each of them discovered against a real
 * cluster, and a second parser that missed one of them would silently classify
 * a named refusal as "the chain never answered" — which is retried forever
 * rather than acted on.
 */

/**
 * The Anchor custom error code inside whatever the RPC handed back, or `null`.
 *
 * Three shapes reach here and all three matter. `getSignatureStatuses` returns
 * the bare `{ InstructionError: [i, { Custom: n }] }`. A preflight rejection
 * arrives as a `SolanaError` carrying the same object several levels down under
 * `context.data.err` — and preflight is where most named refusals actually
 * land, because simulation runs before the transaction is accepted. Everything
 * else arrives only as text, which is why the last resort reads the number back
 * out of a message.
 *
 * The number is *extracted*, never compared against: the program's error enum is
 * not append-only (a variant has been deleted from the middle before, which
 * shifted every code after it down by one), so a hardcoded numeric code that
 * decided behaviour would silently start deciding a different one.
 */
export function extractCustomErrorCode(error: unknown, depth = 0): number | null {
  if (error === null || error === undefined || depth > 4) {
    return null;
  }

  if (typeof error === 'object') {
    const direct = customFromInstructionError(error as Record<string, unknown>);
    if (direct !== null) {
      return direct;
    }
    for (const key of ['err', 'data', 'context', 'cause', 'error'] as const) {
      const nested = (error as Record<string, unknown>)[key];
      if (nested !== undefined && nested !== error) {
        const found = extractCustomErrorCode(nested, depth + 1);
        if (found !== null) {
          return found;
        }
      }
    }
  }

  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null;
  return text === null ? null : customFromText(text);
}

function customFromInstructionError(value: Record<string, unknown>): number | null {
  const instructionError = value.InstructionError;
  if (!Array.isArray(instructionError) || instructionError.length < 2) {
    return null;
  }
  const detail = instructionError[1] as { Custom?: unknown } | undefined;
  return detail && typeof detail.Custom === 'number' ? detail.Custom : null;
}

/** `custom program error: 0x1783`, or a `"Custom": 6019` embedded in a serialised error. */
function customFromText(text: string): number | null {
  const hex = /custom program error:?\s*0x([0-9a-fA-F]+)/.exec(text);
  if (hex) {
    return Number.parseInt(hex[1], 16);
  }
  const decimal = /"Custom"\s*:\s*(\d+)/.exec(text);
  return decimal ? Number.parseInt(decimal[1], 10) : null;
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return JSON.stringify(err, (_key, value) => (typeof value === 'bigint' ? `${value}` : value));
}
