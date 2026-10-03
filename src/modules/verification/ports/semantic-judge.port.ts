/**
 * Where a relevance judgement comes from.
 *
 * A port, for the reason every boundary in this codebase is one: the thing
 * behind it is the only part of verification that is neither pure nor free, and
 * it is the part most likely to be swapped. The cost model assumes Claude Haiku
 * at ~$0.0025 a judgement, and *larger models change the sample rate, not the
 * accuracy that matters* — a statement
 * that only means anything if changing the model is a configuration change
 * rather than a rewrite.
 *
 * The port is deliberately thin. It takes rendered text and returns numbers: no
 * policy, no thresholds, no sampling, no verdict. Everything that decides what
 * a judgement *means* lives in the domain, where it is pure and testable
 * without a network — and everything that decides whether to spend at all lives
 * in `SemanticVerificationService`, which calls this at most once per call and
 * often not at all.
 *
 * There is no adapter behind it yet; until there is, the seam exists, is typed,
 * and is exercised by a stub.
 */

/** What the client is asked to send. Already rendered, already bounded. */
export interface SemanticJudgeRequest {
  /** The full prompt text. Its sha256 is what the verdict pins. */
  readonly prompt: string;
  /** Pinned at 0 — reproducibility starts here, though it does not end here. */
  readonly temperature: 0;
  /** The truncation bound already applied, passed so the client can assert it. */
  readonly maxInputChars: number;
  /**
   * How long the caller will wait.
   *
   * The service enforces its own deadline regardless — a client that ignores
   * this one cannot hold a verification worker open — but a client that honours
   * it can abort the request and stop paying for tokens nobody will read.
   */
  readonly timeoutMs: number;
}

/**
 * What came back.
 *
 * `modelId` is the **actual** snapshot that answered, not the one configured.
 * A client that resolved an alias, failed over to a second model, or was routed
 * by a gateway must report what really produced the numbers: everything
 * downstream treats this field as the thing a dispute will be re-run against,
 * and a hopeful value there is worse than no value, which at least degrades
 * loudly.
 */
export interface SemanticJudgeResponse {
  readonly modelId: string;
  readonly relevance: number;
  readonly completeness: number;
  readonly coherence: number;
  readonly requestInScope: boolean;
  readonly reason: string | null;
}

export interface SemanticJudgePort {
  judge(request: SemanticJudgeRequest): Promise<SemanticJudgeResponse>;
}

/** DI token for the bound {@link SemanticJudgePort}. */
export const SEMANTIC_JUDGE = 'SEMANTIC_JUDGE';
