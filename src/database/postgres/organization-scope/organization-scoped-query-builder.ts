import { assertOrganizationScopedSql } from './organization-scope.assert';

/**
 * Query-builder methods that put a statement on the wire. The built SQL is
 * checked for the tenant column immediately before each of them runs.
 */
const TERMINAL_METHODS: ReadonlySet<string> = new Set([
  'execute',
  'getCount',
  'getExists',
  'getMany',
  'getManyAndCount',
  'getOne',
  'getOneOrFail',
  'getRawAndEntities',
  'getRawMany',
  'getRawOne',
  'stream',
]);

/**
 * Wraps a query builder so every terminal call asserts the built SQL references
 * `organization_id`.
 *
 * Unlike `find()` there is no options object to inspect — a builder can express
 * anything — so the check has to happen against the generated statement, as
 * late as possible and still before execution.
 *
 * Builder methods return `this` for chaining, which would hand back the
 * unguarded target and defeat the wrapper from the first `.where()` onwards, so
 * a returned self is swapped for the proxy on the way out.
 */
export function guardOrganizationScope<T extends object>(queryBuilder: T, operation: string): T {
  const proxy: T = new Proxy(queryBuilder, {
    // The target is passed as the receiver so TypeORM's own `this` bindings
    // keep working inside the builder.
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;

      if (typeof value !== 'function') {
        return value;
      }

      const name = String(property);

      return function guarded(...args: unknown[]) {
        if (TERMINAL_METHODS.has(name)) {
          assertOrganizationScopedSql(
            (target as { getQuery?: () => string }).getQuery?.(),
            `${operation}.${name}`,
          );
        }

        const result = (value as (...callArgs: unknown[]) => unknown).apply(target, args);

        // `.where(...)`, `.andWhere(...)` and friends return the builder itself.
        return result === target ? proxy : result;
      };
    },
  }) as T;

  return proxy;
}
