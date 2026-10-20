import { readdirSync, statSync } from 'fs';
import { join } from 'path';

import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';

import {
  HEAVY_READS,
  OWN_LIMITER_ROUTES,
  ROUTE_RULES,
} from '@shared/rate-limit/user-rate-limit.config';

/**
 * Every route `user-rate-limit.config.ts` names is a route a controller
 * declares. A rule keyed by a path that drifted (a renamed parameter, a moved
 * controller) would match nothing and leave the route on the generic window
 * without a word, so the table is checked against the controllers' own
 * metadata, the same strings Express matches.
 */
const SRC = join(__dirname, '../../../../src');

function controllerFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) controllerFiles(full, out);
    else if (full.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const join2 = (...parts: string[]) =>
  `/${parts
    .flatMap((part) => part.split('/'))
    .filter(Boolean)
    .join('/')}`;

function declaredRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of controllerFiles(SRC)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const exported = require(file) as Record<string, unknown>;
    for (const value of Object.values(exported)) {
      if (typeof value !== 'function') continue;
      const prefixes = [Reflect.getMetadata(PATH_METADATA, value) ?? []].flat() as string[];
      if (prefixes.length === 0 && !Reflect.hasMetadata('__controller__', value)) continue;
      const proto = (value as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) continue;
        const paths = [Reflect.getMetadata(PATH_METADATA, handler) ?? '/'].flat() as string[];
        for (const prefix of prefixes.length ? prefixes : ['']) {
          for (const path of paths) routes.add(`${RequestMethod[method]} ${join2(prefix, path)}`);
        }
      }
    }
  }
  return routes;
}

describe('user rate limit route table', () => {
  const routes = declaredRoutes();

  it('found the controllers', () => {
    expect(routes.size).toBeGreaterThan(150);
    expect(routes.has('GET /deposits/:depositId')).toBe(true);
  });

  it.each([...Object.keys(ROUTE_RULES), ...OWN_LIMITER_ROUTES])(
    '%s is a declared route',
    (route) => {
      expect(routes.has(route)).toBe(true);
    },
  );

  it('lists every heavy read once', () => {
    expect(new Set(HEAVY_READS).size).toBe(HEAVY_READS.length);
  });
});
