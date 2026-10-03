/**
 * The judgement prompt, versioned.
 *
 * Two properties, both required:
 *
 * **Deterministic bytes.** The same call renders the same prompt, always —
 * request and response are serialised canonically, so key order, whitespace and
 * anything else that varies between two encodings of one document cannot change
 * the hash. Without that, `promptHash` records the encoder rather than the
 * question, and two identical calls look like two different judgements.
 *
 * **A version that moves when the words do.** {@link SEMANTIC_PROMPT_VERSION}
 * is bumped by hand for any edit to the text below, and it is stored on every
 * verdict. A prompt edit changes verdicts across the whole catalogue exactly
 * like a policy edit does, and it must be as visible.
 *
 * The prompt also asks for `requestInScope`. That is the `MISAPPLIED` half of
 * the verdict vocabulary — a well-formed answer to a
 * request the tool was never meant to serve is our failure, not the provider's,
 * and without asking the question there is no way to tell it apart from a
 * provider who answered the wrong thing.
 */

import { canonicalJson } from '@modules/payment/domain/request-hash';
import { JsonValue } from '@modules/tool/domain/mapping/mapping.types';
import { createHash } from 'crypto';

/**
 * Bump on **any** edit to the rendered text, including whitespace.
 *
 * Sealed onto every verdict, so an old verdict names the words it was produced
 * by even after this file has moved on.
 */
export const SEMANTIC_PROMPT_VERSION = 1;

/**
 * The truncation bound.
 *
 * Caps input cost, and a bad response is usually detectable from a prefix. It
 * is recorded on the verdict because it changes what the model saw: a judgement
 * of the first 8,000 characters is a different judgement from one of the first
 * 800, and a replay that used the wrong bound would not reproduce.
 */
export const MAX_SEMANTIC_INPUT_CHARS = 8_000;

const TRUNCATION_MARKER = '…[truncated]';

export interface RenderSemanticPromptInput {
  /** The tool arguments the agent sent. */
  readonly request?: JsonValue;
  /** The response **after** the binding's response mapping. */
  readonly response: JsonValue;
  readonly maxInputChars?: number;
}

export interface RenderedSemanticPrompt {
  readonly text: string;
  /** sha256 of {@link text}, hex. What the verdict records. */
  readonly hash: string;
  readonly version: number;
  readonly maxInputChars: number;
  /** Did either document hit the bound? Shown on the receipt, not just logged. */
  readonly truncated: boolean;
}

export function renderSemanticPrompt(input: RenderSemanticPromptInput): RenderedSemanticPrompt {
  const maxInputChars = input.maxInputChars ?? MAX_SEMANTIC_INPUT_CHARS;

  const request = truncate(canonicalJson(input.request ?? null), maxInputChars);
  const response = truncate(canonicalJson(input.response), maxInputChars);

  const text = [
    'You are evaluating whether an API response is useful for the request that produced it.',
    '',
    `REQUEST:  ${request.text}`,
    `RESPONSE: ${response.text}`,
    '',
    'Score 0.0–1.0 on:',
    '- relevance:    does the content address the request?',
    '- completeness: is there enough to act on?',
    '- coherence:    is it well-formed and internally consistent?',
    '',
    'Also answer, as a boolean:',
    '- requestInScope: is the request itself something this tool is meant to answer?',
    "  Answer false when the request is outside the tool's purpose. A provider is",
    '  not at fault for a request that should never have reached it.',
    '',
    'Return JSON and nothing else:',
    '{ "relevance": n, "completeness": n, "coherence": n, "requestInScope": true|false, "reason": "…" }',
  ].join('\n');

  return Object.freeze({
    text,
    hash: createHash('sha256').update(text, 'utf8').digest('hex'),
    version: SEMANTIC_PROMPT_VERSION,
    maxInputChars,
    truncated: request.truncated || response.truncated,
  });
}

/**
 * Both documents are bounded, not just the response.
 *
 * The doc only names the response, because that is where the size normally is.
 * The request is agent-supplied, though, and an unbounded agent-supplied string
 * in a prompt is both a cost and a prompt-injection surface — bounding it costs
 * nothing and removes one way for a caller to make a judgement expensive.
 */
function truncate(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}${TRUNCATION_MARKER}`, truncated: true };
}
