/**
 * The reproducibility gate.
 *
 * Reproducibility requires recording the model and the prompt. The rule and the
 * reason fit in two sentences: *a dispute is adjudicated precisely on old
 * verdicts*, and *a slashing mechanism that cannot reproduce its own evidence
 * is not defensible*.
 *
 * So this is a gate rather than a validator with a warning. A judgement that
 * cannot name its model and its prompt is **refused entry to a verdict** —
 * `VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE`, thrown at the boundary. The
 * alternative is worse than a missing judgement: a verdict row that looks
 * exactly like a defensible one, is stored, is counted in a failure rate, and
 * turns out three months later to be un-re-derivable at the moment someone
 * challenges the slash it justified.
 *
 * Callers are expected to catch it and degrade — see
 * `services/semantic-verification.service.ts`, where an unreproducible
 * judgement becomes {@link SemanticOutcome.UNAVAILABLE} and therefore credits
 * the provider. Refusing to record is not the same as failing the provider.
 */

import { VerificationErrors } from '../errors/verification.errors';
import { SemanticContext, SemanticContextDraft } from './semantic.types';

/**
 * A pinned model id ends in an immutable snapshot: a date stamp or a digest.
 *
 * `claude-haiku-4-5-20251001` passes. `claude-haiku-4-5` does not, and that is
 * the point — a bare family name is resolved by the provider at call time, so
 * it names *whatever is current*, which is exactly the floating reference the
 * doc forbids. A verdict recorded against it cannot be replayed.
 */
const PINNED_SNAPSHOT = /(?:^|[-@:_/])(?:\d{8}|\d{4}-\d{2}-\d{2}|sha256:[0-9a-f]{8,})$/;

/**
 * Explicitly floating suffixes, caught before the snapshot rule so the operator
 * gets "floating alias" rather than the more cryptic "not a pinned snapshot".
 */
const FLOATING_ALIAS = /(?:^|[-@:_/])(?:latest|default|preview|stable|current)$/i;

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sealSemanticContext(draft: SemanticContextDraft): SemanticContext {
  const modelId = typeof draft.modelId === 'string' ? draft.modelId.trim() : '';
  if (modelId.length === 0) {
    throw incomplete('modelId', 'missing — a verdict must name the model that produced it');
  }
  if (FLOATING_ALIAS.test(modelId)) {
    throw incomplete('modelId', `"${modelId}" is a floating alias, not a pinned snapshot`);
  }
  if (!PINNED_SNAPSHOT.test(modelId)) {
    throw incomplete(
      'modelId',
      `"${modelId}" does not name an immutable snapshot (expected a date or digest suffix)`,
    );
  }

  const { promptVersion } = draft;
  if (typeof promptVersion !== 'number' || !Number.isInteger(promptVersion) || promptVersion < 1) {
    throw incomplete('promptVersion', 'missing or not a positive integer');
  }

  const promptHash = typeof draft.promptHash === 'string' ? draft.promptHash : '';
  if (!SHA256_HEX.test(promptHash)) {
    throw incomplete('promptHash', 'missing or not a lowercase sha256 hex digest');
  }

  // Temperature is the one field with exactly one permitted value. A judgement
  // taken at any other temperature is not reproducible even with the model and
  // the prompt pinned, so there is nothing to record — only something to refuse.
  if (draft.temperature !== 0) {
    throw incomplete(
      'temperature',
      `must be 0 for a reproducible judgement, got ${draft.temperature}`,
    );
  }

  const { maxInputChars } = draft;
  if (typeof maxInputChars !== 'number' || !Number.isInteger(maxInputChars) || maxInputChars < 1) {
    throw incomplete('maxInputChars', 'missing or not a positive integer');
  }

  return Object.freeze({
    modelId,
    promptVersion,
    promptHash,
    temperature: 0,
    maxInputChars,
  });
}

function incomplete(field: string, reason: string) {
  return VerificationErrors.semanticContextIncomplete({ field, reason });
}
