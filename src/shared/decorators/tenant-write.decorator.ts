import { SetMetadata } from '@nestjs/common';

export const NO_EPOCH_BUMP_KEY = 'tenant_write_no_epoch_bump';
export const BUMPS_OPERATOR_CONSOLE_KEY = 'tenant_write_bumps_operator_console';

/**
 * A `POST` that only reads (a preview, a validation, a lookup): it changes
 * nothing, so `TenantWriteEpochInterceptor` bumps nothing after it.
 *
 * Separate from `@BlockedSessionReadOnly`, which also lets a blocked session
 * through and is a decision about blocks, not about caches.
 */
export const NoEpochBump = () => SetMetadata(NO_EPOCH_BUMP_KEY, true);

/**
 * Writes the operator console lists (a dispute, a report, a tool request, a
 * provider tool sent for review, a provider registration, a slash case
 * acknowledged): after one, the global `operator` scope is bumped too, so the
 * console's cached work lists show it at once. On a class or a handler.
 */
export const BumpsOperatorConsole = () => SetMetadata(BUMPS_OPERATOR_CONSOLE_KEY, true);
