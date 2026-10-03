import 'reflect-metadata';

import { METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { OperatorCasesController } from '@modules/operator/controllers/operator-cases.controller';
import { OperatorOverrideLogController } from '@modules/operator/controllers/operator-override-log.controller';
import { OperatorProvidersController } from '@modules/operator/controllers/operator-providers.controller';
import {
  OVERRIDE_CODE_METADATA,
  SKIP_OVERRIDE_METADATA,
} from '@modules/operator/decorators/override.decorator';
import { lookupOverride } from '@modules/operator/domain/override-register';
import { REQUIRE_ROLES_METADATA } from '@shared/auth';

/**
 * Every manual intervention appears in the override register; there is no way
 * around it.
 *
 * The property is architectural, so it is delivered by three separate
 * mechanisms and checked by two separate tests:
 *
 * 1. `OverrideLogService.perform` makes the register entry and the mutation
 *    share one transaction — there is no ordering in which one lands without
 *    the other. Checked in `override-log.service.spec.ts`.
 * 2. `OperatorOverrideGuard` refuses any mutating handler that does not name a
 *    register row. Checked in `operator-override.guard.spec.ts`.
 * 3. **This test**, which walks the real controller metadata and asserts that
 *    every mutating route on the operator surface has a code — so the gap is
 *    found before the call rather than on it.
 *
 * It reads Nest's own metadata rather than the source text. A grep over
 * decorators would miss a handler in a file nobody thought to include, and
 * would be fooled by a decorator that is present but commented out.
 */
const OPERATOR_CONTROLLERS = [
  OperatorCasesController,
  OperatorOverrideLogController,
  OperatorProvidersController,
];

const MUTATING = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
]);

interface RouteInfo {
  readonly controller: string;
  readonly handler: string;
  readonly method: RequestMethod;
  readonly overrideCode: string | undefined;
  readonly exemption: string | undefined;
  readonly roles: unknown;
}

function routesOf(controller: new (...args: never[]) => unknown): RouteInfo[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => prototype[name])
    .filter((fn): fn is (...args: unknown[]) => unknown => typeof fn === 'function')
    .filter((fn) => Reflect.hasMetadata(METHOD_METADATA, fn))
    .map((fn) => ({
      controller: controller.name,
      handler: fn.name,
      method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
      overrideCode: Reflect.getMetadata(OVERRIDE_CODE_METADATA, fn) as string | undefined,
      exemption: Reflect.getMetadata(SKIP_OVERRIDE_METADATA, fn) as string | undefined,
      roles: Reflect.getMetadata(REQUIRE_ROLES_METADATA, fn),
    }));
}

describe('override register coverage', () => {
  const routes = OPERATOR_CONTROLLERS.flatMap(routesOf);

  it('finds routes at all (the test is meaningless if it does not)', () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some((route) => MUTATING.has(route.method))).toBe(true);
  });

  it('gives every mutating operator route a register code or a named exemption', () => {
    const uncovered = routes
      .filter((route) => MUTATING.has(route.method))
      .filter((route) => !route.overrideCode && !route.exemption)
      .map((route) => `${route.controller}.${route.handler}`);

    expect(uncovered).toEqual([]);
  });

  /**
   * An exemption is a decision somebody made; a missing decorator is a decision
   * nobody made. Requiring the reason string means an exemption shows up in a
   * diff as prose that can be argued with.
   */
  it('requires an exemption to state its reason', () => {
    for (const route of routes.filter((r) => r.exemption !== undefined)) {
      expect(route.exemption!.length).toBeGreaterThan(20);
    }
  });

  it('cites only register rows that exist and are implemented', () => {
    for (const route of routes.filter((r) => r.overrideCode)) {
      const definition = lookupOverride(route.overrideCode!);
      expect(definition).toBeDefined();
      expect(definition!.implemented).toBe(true);
    }
  });

  /**
   * Fails closed on roles too.
   *
   * `OperatorRolesGuard` refuses a mutating handler with no `@RequireRoles`, so
   * a route that forgot is broken rather than open. This asserts the same thing
   * statically, because discovering it at runtime means discovering it in
   * production.
   */
  it('gives every mutating operator route a role requirement', () => {
    const roleless = routes
      .filter((route) => MUTATING.has(route.method))
      .filter((route) => route.roles === undefined)
      .map((route) => `${route.controller}.${route.handler}`);

    expect(roleless).toEqual([]);
  });

  /**
   * Read routes must NOT carry a code.
   *
   * Read tools do need auditing, and the audit a lookup needs is
   * access logging. Putting `GET /operator/queue` into the override register
   * would bury the interventions under the reads of them, which is the failure
   * mode of every audit log nobody uses.
   */
  it('leaves read routes out of the register', () => {
    const readsWithCodes = routes
      .filter((route) => !MUTATING.has(route.method))
      .filter((route) => route.overrideCode !== undefined)
      .map((route) => `${route.controller}.${route.handler}`);

    expect(readsWithCodes).toEqual([]);
  });
});
