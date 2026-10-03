import { SetMetadata } from '@nestjs/common';

export const OVERRIDE_CODE_METADATA = 'operator:override-code';

/**
 * Declares which row of the override register this handler exercises.
 *
 * `@Override('S-3')` on the decide endpoint, `@Override('S-1')` on suspend, and
 * so on. The code decides three things the handler does not get to choose —
 * which roles may call it, whether a second identity is required, and whether
 * it is reversible — because those belong to the *action*, and an endpoint that
 * carried its own approval requirement could quietly lower it.
 *
 * ## The reason this is mandatory rather than advisory
 *
 * The override register must have no way around it. A decorator
 * that endpoints *may* use gives a register with exactly as many gaps as there
 * are endpoints somebody forgot. `OperatorOverrideGuard` therefore refuses any
 * non-`GET` operator handler that has no `@Override`, so the failure mode of
 * forgetting is a 500 on the first call rather than a silent hole — and
 * `test/unit/operator/override-coverage.spec.ts` walks the real Nest route
 * table so the hole is found before the call.
 *
 * A read-only handler needs none. Read tools are audited too, and that is true
 * — but the audit a lookup needs is access logging, not the override register,
 * and putting `GET /operator/queue` in a list of interventions would bury the
 * interventions.
 */
export const Override = (code: string): MethodDecorator =>
  SetMetadata(OVERRIDE_CODE_METADATA, code);

export const SKIP_OVERRIDE_METADATA = 'operator:override-exempt';

/**
 * Marks a mutating handler that genuinely performs no intervention.
 *
 * There is exactly one today — `POST /operator/cases/:id/claim`, which assigns
 * a case to the operator who asked for it. It changes nobody's money and
 * nobody's state but the queue's, and it is a `POST` only because it is not
 * idempotent.
 *
 * The exemption is a named decorator rather than a quiet omission so it appears
 * in the same coverage test: an exempt route is a decision somebody made and
 * can be argued with, and a missing decorator is a decision nobody made.
 */
export const OverrideExempt = (reason: string): MethodDecorator =>
  SetMetadata(SKIP_OVERRIDE_METADATA, reason);
