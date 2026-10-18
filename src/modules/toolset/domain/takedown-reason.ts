/**
 * Why a provider tool was taken down, in words its provider may read (design
 * spec §9). The operator's own note and identity stay in the cutoff and the
 * override register; this code, and an optional note written for the
 * provider, are what the provider console shows.
 */
export enum TakedownReasonCode {
  /** Poses as another maker or as the platform. */
  IMPERSONATION = 'IMPERSONATION',
  /** Its summary or schemas address the model (prompt injection). */
  MODEL_INSTRUCTIONS = 'MODEL_INSTRUCTIONS',
  /** Its inputs collect credentials or other secrets. */
  SECRET_COLLECTION = 'SECRET_COLLECTION',
  /** Its outputs are harmful or deceptive. */
  HARMFUL_OUTPUT = 'HARMFUL_OUTPUT',
  /** A legal request. */
  LEGAL_REQUEST = 'LEGAL_REQUEST',
  /** Another breach of the provider terms; the public note says which. */
  POLICY_VIOLATION = 'POLICY_VIOLATION',
}

export const TAKEDOWN_REASON_LABEL: Readonly<Record<TakedownReasonCode, string>> = Object.freeze({
  [TakedownReasonCode.IMPERSONATION]: 'Impersonation',
  [TakedownReasonCode.MODEL_INSTRUCTIONS]: 'Instructions to models',
  [TakedownReasonCode.SECRET_COLLECTION]: 'Collects secrets',
  [TakedownReasonCode.HARMFUL_OUTPUT]: 'Harmful output',
  [TakedownReasonCode.LEGAL_REQUEST]: 'Legal request',
  [TakedownReasonCode.POLICY_VIOLATION]: 'Breach of the provider terms',
});

/** The longest note written for the provider. */
export const TAKEDOWN_PUBLIC_NOTE_MAX = 500;
