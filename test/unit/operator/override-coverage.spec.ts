import 'reflect-metadata';

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import {
  OVERRIDE_CODE_METADATA,
  SKIP_OVERRIDE_METADATA,
} from '@modules/operator/decorators/override.decorator';
import { lookupOverride } from '@modules/operator/domain/override-register';
import { OperatorOverrideGuard } from '@modules/operator/guards/operator-override.guard';
import { OperatorRolesGuard, REQUIRE_ROLES_METADATA } from '@shared/auth';

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
type ControllerClass = new (...args: never[]) => unknown;

const SRC = join(__dirname, '../../../src');

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, out);
    else if (full.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function pathsOf(controller: ControllerClass): string[] {
  const path = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
  return (Array.isArray(path) ? path : [path ?? '']).map((p) => p.replace(/^\/+/, ''));
}

/**
 * Every controller in `src` whose route prefix starts with `operator`, found
 * from Nest's own route metadata rather than a hand-written list (review L-4:
 * the old list of three missed `operator/tool-requests`). A new controller
 * under `/operator` is covered the moment it exists.
 */
const OPERATOR_CONTROLLERS: ControllerClass[] = controllerFiles(SRC)
  // A dynamic list of files: `require` is the only synchronous way to load it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  .flatMap((file) => Object.values(require(file) as Record<string, unknown>))
  .filter(
    (value): value is ControllerClass =>
      typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value),
  )
  .filter((controller) => pathsOf(controller).some((path) => path.startsWith('operator')));

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

function routesOf(controller: ControllerClass): RouteInfo[] {
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

/**
 * The one operator controller that cannot sit behind the operator guards: the
 * sign-in routes that issue the session those guards check. Pinned by name and
 * by route list, and required to mount no guard, so a write added to it is a
 * red test rather than an unguarded intervention.
 */
const PRE_AUTH_CONTROLLERS: Readonly<Record<string, readonly string[]>> = {
  OperatorSignInController: ['challenge', 'logout', 'verify'],
};

describe('override register coverage', () => {
  const routes = OPERATOR_CONTROLLERS.filter(
    (controller) => !(controller.name in PRE_AUTH_CONTROLLERS),
  ).flatMap(routesOf);

  it('keeps the pre-authentication controller to its sign-in routes, with no guard', () => {
    for (const [name, handlers] of Object.entries(PRE_AUTH_CONTROLLERS)) {
      const controller = OPERATOR_CONTROLLERS.find((candidate) => candidate.name === name);
      expect(controller).toBeDefined();
      expect(
        routesOf(controller!)
          .map((route) => route.handler)
          .sort(),
      ).toEqual([...handlers]);
      expect(Reflect.getMetadata(GUARDS_METADATA, controller!)).toBeUndefined();
    }
  });

  it('finds routes at all (the test is meaningless if it does not)', () => {
    expect(routes.length).toBeGreaterThan(5);
    expect(routes.some((route) => MUTATING.has(route.method))).toBe(true);
    // The controllers the hand-written list used to miss are found.
    expect(OPERATOR_CONTROLLERS.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        'OperatorCasesController',
        'OperatorToolRequestsController',
        'OperatorReferenceController',
        'OperatorApprovalsController',
        'OperatorOperatorsController',
        'OperatorToolVerificationController',
        'OperatorOfficialToolsetsController',
      ]),
    );
  });

  /**
   * Metadata alone enforces nothing: `@RequireRoles` and the register code are
   * checked by `OperatorRolesGuard` and `OperatorOverrideGuard` at runtime, so
   * a controller with a write must mount both.
   */
  it('mounts the role and override guards on every operator controller that writes', () => {
    const unguarded = OPERATOR_CONTROLLERS.filter(
      (controller) => !(controller.name in PRE_AUTH_CONTROLLERS),
    )
      .filter((controller) => routesOf(controller).some((route) => MUTATING.has(route.method)))
      .filter((controller) => {
        const guards = (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];
        return !guards.includes(OperatorRolesGuard) || !guards.includes(OperatorOverrideGuard);
      })
      .map((controller) => controller.name);

    expect(unguarded).toEqual([]);
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
