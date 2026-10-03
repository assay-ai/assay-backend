import { AppError } from '@shared/errors/app-errors';

import { MappingFault } from './mapping.types';

const FAULTS = new Set<string>(Object.values(MappingFault));

/**
 * Recover the fault attribution from a thrown mapping error.
 *
 * Every throw site in `evaluate.ts`, `request-mapper.ts` and
 * `response-mapper.ts` already attaches `fault` to the error context — the
 * engine has always *reported* who it believes is at fault. What was missing
 * was any way to read it back, because `AppError` formatted the context into a
 * message and dropped it; `AppError.context` now retains it, and this is the
 * one function that looks.
 *
 * Why it matters at the call site: the three faults route to three different
 * outcomes, and two of them are indistinguishable without this.
 *
 * ```text
 * AGENT     → REQUEST_ERROR  → return to the agent, do NOT fail over
 * PLATFORM  → SYSTEM_ERROR   → fail over to a different provider
 * PROVIDER  → DATA_RESULT    → the payload is the problem; verification decides
 * ```
 *
 * A router without this would see three identical `TOOL_MAPPING_*` exceptions
 * and would have to guess. Guessing "retry elsewhere" burns a second provider
 * on an agent's malformed arguments; guessing "give up" turns our own mistyped
 * JSONPath into a failed tool call that a working provider could have served.
 *
 * Returns `null` for anything that is not an `AppError` carrying a recognised
 * fault, which the caller must treat as "not a mapping failure" — an unknown
 * error is a transport failure until proven otherwise, and that road ends at
 * `SYSTEM_ERROR`, the class with no penalty.
 */
export function mappingFaultOf(error: unknown): MappingFault | null {
  if (!(error instanceof AppError)) return null;

  const fault = error.context?.fault;
  return typeof fault === 'string' && FAULTS.has(fault) ? (fault as MappingFault) : null;
}
