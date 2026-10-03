/**
 * The seam `VerificationSettlementService.settle()` posts every judged call
 * through, so an SLA window can accumulate without this
 * module gaining a hard dependency on the provider domain.
 *
 * A port rather than a direct import of `SlaWindowService` for the same
 * reason `SignerPort` and `NotificationPort` are ports: the caller (this
 * module) and the implementation (`src/modules/provider/services/
 * sla-window.service.ts`) sit in different domains, and the domain that knows
 * *when* to post — the instant a call is judged and settled — is not the
 * domain that owns *what* a window is. `SlaWindowModule` is the only binder:
 * it provides `SlaWindowService` and binds this token to it, and
 * `VerificationModule` imports that one small module rather than the whole
 * `ProviderModule` — see `sla-window.module.ts` for why that split is what
 * keeps the two domains from importing each other.
 */

export interface PostSlaWindowCallInput {
  /**
   * The provider's own organization id. Equal to {@link providerId} — see
   * `SlaWindowEntity.providerId` for why both are carried — and named
   * separately here because it is what the row is written under.
   */
  readonly organizationId: string;
  readonly providerId: string;
  /**
   * `null` on every call the router never resolved a binding for — every
   * intent written before binding assignment was recorded, and any intent
   * whose binding assignment is otherwise missing. `postCall` is a no-op in that case: a window is
   * per-binding, and there is nothing to attribute the call to.
   */
  readonly bindingId: string | null;
  readonly toolId: string;
  readonly intentId: string;
  readonly agentId: string;
  /**
   * One of `VerdictStatus`, or the `'UNVERIFIED'` sentinel
   * `verification-settlement.service.ts` writes when no decision policy
   * exists for the tool at all. Neither counts toward the window unless it is
   * a real `PASS`/`FAIL` — see `countsTowardWindow`.
   */
  readonly verdictStatus: string | null;
  readonly reasonCode: string | null;
  /** Minor units — `intent.price.amount`. */
  readonly priceAmount: string;
  readonly assetId: string;
  /** When the call was judged, which is when it is posted — not when it was made. */
  readonly postedAt: Date;
}

export interface SlaWindowPoster {
  /**
   * Posts one judged call to its binding's open SLA window, opening one
   * lazily if none exists.
   *
   * Idempotent: a duplicate post for the same `intentId` — BullMQ redelivers
   * at least once, and `VerificationSettlementService.settle()` can retry
   * after a crash — is a no-op, never an error, and never a double count.
   */
  postCall(input: PostSlaWindowCallInput): Promise<void>;
}

export const SLA_WINDOW_POSTER = 'SLA_WINDOW_POSTER';
