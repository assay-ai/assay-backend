import { SetMetadata } from '@nestjs/common';

import { OperatorRole } from '@modules/operator/domain/override-register';

/** The metadata key `OperatorRolesGuard` reads via `Reflector`. */
export const REQUIRE_ROLES_METADATA = 'requireRoles';

/**
 * Declares which operator roles may reach a handler.
 *
 * The register (`OVERRIDE_REGISTER`) is the source of truth for *which*
 * roles a given override permits; this decorator is how a controller states
 * the answer for its own route so `OperatorRolesGuard` can check it before
 * the handler runs; a service that also calls `rolesSatisfy` against the
 * register for a specific override code is checking the same fact a second
 * time, deliberately, the way `class-validator` and a `CHECK` constraint both
 * validate an override's reason length.
 *
 * A handler with **no** `@RequireRoles` is not "open to any authenticated
 * operator" — see `OperatorRolesGuard` for what actually happens to it.
 */
export const RequireRoles = (...roles: OperatorRole[]) =>
  SetMetadata(REQUIRE_ROLES_METADATA, roles);
