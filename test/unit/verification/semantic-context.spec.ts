import {
  SEMANTIC_PROMPT_VERSION,
  SemanticContextDraft,
  renderSemanticPrompt,
  sealSemanticContext,
} from '@modules/verification/domain';
import { VerificationErrorCode } from '@modules/verification/errors/verification.errors';
import { BaseError } from '@shared/errors/base.error';
import { createHash } from 'crypto';

/**
 * Reproducibility.
 *
 * A verdict is evidence, and evidence that cannot be re-derived is an
 * assertion. Reproducibility requires recording the model and the prompt, and
 * the consequence is blunt: *a slashing mechanism that cannot reproduce its own evidence is not
 * defensible*.
 *
 * So the seal is a **gate**, not a decoration. A judgement missing its model id
 * or its prompt version is refused entry to a verdict, loudly, at the boundary
 * — because the alternative is a row in the verdict table that looks exactly
 * like a good one until someone tries to defend it in a dispute months later.
 */

const COMPLETE: SemanticContextDraft = {
  modelId: 'claude-haiku-4-5-20251001',
  promptVersion: SEMANTIC_PROMPT_VERSION,
  promptHash: 'a'.repeat(64),
  temperature: 0,
  maxInputChars: 8_000,
};

function codeOf(act: () => unknown): string | undefined {
  try {
    act();
    return undefined;
  } catch (error) {
    return (error as BaseError).errorCode;
  }
}

const INCOMPLETE = VerificationErrorCode.VERIFICATION_SEMANTIC_CONTEXT_INCOMPLETE;

describe('sealSemanticContext — what a verdict is allowed to record', () => {
  it('seals a complete context', () => {
    expect(sealSemanticContext(COMPLETE)).toEqual({
      modelId: 'claude-haiku-4-5-20251001',
      promptVersion: SEMANTIC_PROMPT_VERSION,
      promptHash: 'a'.repeat(64),
      temperature: 0,
      maxInputChars: 8_000,
    });
  });

  it('refuses a judgement with no model id', () => {
    expect(codeOf(() => sealSemanticContext({ ...COMPLETE, modelId: undefined }))).toBe(INCOMPLETE);
    expect(codeOf(() => sealSemanticContext({ ...COMPLETE, modelId: null }))).toBe(INCOMPLETE);
    expect(codeOf(() => sealSemanticContext({ ...COMPLETE, modelId: '   ' }))).toBe(INCOMPLETE);
  });

  it('refuses a floating model alias — a silent upgrade would rewrite old verdicts', () => {
    for (const modelId of ['latest', 'claude-haiku-latest', 'claude-haiku-4-5', 'default']) {
      expect(codeOf(() => sealSemanticContext({ ...COMPLETE, modelId }))).toBe(INCOMPLETE);
    }
  });

  it('refuses a judgement with no prompt version', () => {
    expect(codeOf(() => sealSemanticContext({ ...COMPLETE, promptVersion: undefined }))).toBe(
      INCOMPLETE,
    );
    expect(codeOf(() => sealSemanticContext({ ...COMPLETE, promptVersion: null }))).toBe(
      INCOMPLETE,
    );
  });

  it('refuses a prompt version that is not a positive integer', () => {
    for (const promptVersion of [0, -1, 1.5, Number.NaN]) {
      expect(codeOf(() => sealSemanticContext({ ...COMPLETE, promptVersion }))).toBe(INCOMPLETE);
    }
  });

  it('refuses a missing or malformed prompt hash', () => {
    for (const promptHash of [undefined, null, '', 'not-a-hash', 'A'.repeat(64), 'a'.repeat(63)]) {
      expect(codeOf(() => sealSemanticContext({ ...COMPLETE, promptHash }))).toBe(INCOMPLETE);
    }
  });

  it('refuses a temperature other than zero — reproducibility starts there', () => {
    for (const temperature of [undefined, null, 0.1, 1]) {
      expect(codeOf(() => sealSemanticContext({ ...COMPLETE, temperature }))).toBe(INCOMPLETE);
    }
  });

  it('refuses a truncation bound that is missing or not positive', () => {
    for (const maxInputChars of [undefined, null, 0, -1, 1.5]) {
      expect(codeOf(() => sealSemanticContext({ ...COMPLETE, maxInputChars }))).toBe(INCOMPLETE);
    }
  });

  it('names the field it refused, so an operator is not left guessing', () => {
    let thrown: BaseError | undefined;
    try {
      sealSemanticContext({ ...COMPLETE, modelId: undefined });
    } catch (error) {
      thrown = error as BaseError;
    }

    expect(thrown?.message).toMatch(/modelId/);
  });
});

describe('renderSemanticPrompt — the same call renders the same bytes', () => {
  const REQUEST = { query: 'usdc price', limit: 5 };
  const RESPONSE = { results: [{ url: 'https://example.com/a', title: 'USDC' }] };

  it('hashes to sha256 of the rendered text', () => {
    const rendered = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });

    expect(rendered.hash).toBe(createHash('sha256').update(rendered.text, 'utf8').digest('hex'));
  });

  it('renders identically twice', () => {
    const first = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });
    const second = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });

    expect(second).toEqual(first);
  });

  it('is insensitive to key order — the same document is the same prompt', () => {
    const first = renderSemanticPrompt({
      request: { query: 'usdc price', limit: 5 },
      response: RESPONSE,
    });
    const second = renderSemanticPrompt({
      request: { limit: 5, query: 'usdc price' },
      response: RESPONSE,
    });

    expect(second.hash).toBe(first.hash);
  });

  it('renders a different hash for a different response', () => {
    const first = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });
    const second = renderSemanticPrompt({ request: REQUEST, response: { results: [] } });

    expect(second.hash).not.toBe(first.hash);
  });

  it('truncates the response at the bound and says that it did', () => {
    const long = { results: 'x'.repeat(10_000) };
    const rendered = renderSemanticPrompt({ request: REQUEST, response: long, maxInputChars: 100 });

    expect(rendered.truncated).toBe(true);
    expect(rendered.text).toContain('[truncated]');
    expect(rendered.text.length).toBeLessThan(2_000);
  });

  it('does not mark a short response truncated', () => {
    const rendered = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });

    expect(rendered.truncated).toBe(false);
    expect(rendered.text).not.toContain('[truncated]');
  });

  it('carries the pinned prompt version and bound, ready to be sealed', () => {
    const rendered = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });

    expect(rendered.version).toBe(SEMANTIC_PROMPT_VERSION);
    expect(
      sealSemanticContext({
        modelId: 'claude-haiku-4-5-20251001',
        promptVersion: rendered.version,
        promptHash: rendered.hash,
        temperature: 0,
        maxInputChars: rendered.maxInputChars,
      }).promptHash,
    ).toBe(rendered.hash);
  });

  it('asks the model for the three scores and the scope question, as JSON', () => {
    const { text } = renderSemanticPrompt({ request: REQUEST, response: RESPONSE });

    expect(text).toContain('relevance');
    expect(text).toContain('completeness');
    expect(text).toContain('coherence');
    expect(text).toContain('requestInScope');
  });
});
