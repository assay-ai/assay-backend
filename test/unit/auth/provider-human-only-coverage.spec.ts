import 'reflect-metadata';

import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';

import { HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

/**
 * Review A-1: an agent machine credential (`assay_sk_live_…`) passed every
 * provider route, so a leaked CI token could re-point the payout address to
 * its own wallet, swap a binding's upstream and publish it, pause supply and
 * manage stake. Those are the provider's account controls, and like the
 * buyer's spend policy they belong to a person.
 *
 * Walks the real controller metadata, in the style of the operator
 * `override-coverage.spec.ts`, so a write added to any `providers…` controller
 * later is a red test rather than a route a machine token can call. A route
 * that should stay open to an agent goes in {@link AGENT_ALLOWED} with its
 * reason, where it shows up in a diff as prose that can be argued with.
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

const PROVIDER_CONTROLLERS: ControllerClass[] = controllerFiles(SRC)
  // A dynamic list of files: `require` is the only synchronous way to load it.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  .flatMap((file) => Object.values(require(file) as Record<string, unknown>))
  .filter(
    (value): value is ControllerClass =>
      typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value),
  )
  .filter((controller) => pathsOf(controller).some((path) => path.startsWith('providers')));

const READS = new Set([RequestMethod.GET, RequestMethod.HEAD]);

/** `Controller.handler` → why an agent credential may call it. Empty on purpose. */
const AGENT_ALLOWED: Readonly<Record<string, string>> = {};

/**
 * The controllers whose every route, reads included, is the person's: they
 * exist to change where the provider is paid, what it serves and what it has
 * staked, and nothing in the code reads them with a machine token.
 */
const PERSON_ONLY_CONTROLLERS = [
  'ProviderPayoutAddressController',
  'ProviderRegistrationController',
  'ProviderStakeAuthorityController',
  'ProviderStakeIntentController',
  'ProviderToolBindingsController',
  'ProviderSlashRequestsController',
];

interface RouteInfo {
  readonly name: string;
  readonly method: RequestMethod;
  readonly guards: readonly unknown[];
}

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) ?? []) as unknown[];
}

function routesOf(controller: ControllerClass): RouteInfo[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => prototype[name])
    .filter((fn): fn is (...args: unknown[]) => unknown => typeof fn === 'function')
    .filter((fn) => Reflect.hasMetadata(METHOD_METADATA, fn))
    .map((fn) => ({
      name: `${controller.name}.${fn.name}`,
      method: Reflect.getMetadata(METHOD_METADATA, fn) as RequestMethod,
      // Class-level guards run before method-level ones, in declaration order.
      guards: [...guardsOf(controller), ...guardsOf(fn)],
    }));
}

/** `HumanSessionGuard` reads the session `SessionAuthGuard` attached, so it must run second. */
function isPersonOnly(route: RouteInfo): boolean {
  const session = route.guards.indexOf(SessionAuthGuard);
  const human = route.guards.indexOf(HumanSessionGuard);
  return session !== -1 && human > session;
}

describe('provider routes: person-only coverage (review A-1)', () => {
  const routes = PROVIDER_CONTROLLERS.flatMap(routesOf);

  it('finds the provider surface (the test is meaningless if it does not)', () => {
    expect(PROVIDER_CONTROLLERS.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        ...PERSON_ONLY_CONTROLLERS,
        'ProviderConnectivityController',
        'ProviderSlashProposalsController',
      ]),
    );
    expect(routes.filter((route) => !READS.has(route.method)).length).toBeGreaterThan(20);
  });

  it('refuses an agent credential on every provider write', () => {
    const open = routes
      .filter((route) => !READS.has(route.method))
      .filter((route) => !(route.name in AGENT_ALLOWED))
      .filter((route) => !isPersonOnly(route))
      .map((route) => route.name);

    expect(open).toEqual([]);
  });

  it('keeps the account-control controllers person-only for reads too', () => {
    const open = routes
      .filter((route) => PERSON_ONLY_CONTROLLERS.includes(route.name.split('.')[0]))
      .filter((route) => !isPersonOnly(route))
      .map((route) => route.name);

    expect(open).toEqual([]);
  });

  it('gives every agent exemption a reason and a route that exists', () => {
    for (const [name, reason] of Object.entries(AGENT_ALLOWED)) {
      expect(routes.map((route) => route.name)).toContain(name);
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});
