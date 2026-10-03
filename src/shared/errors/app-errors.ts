import { BaseError } from './base.error';

export interface ErrorDefinition<TArgs extends unknown[] = []> {
  code: string;
  message: (...args: TArgs) => string;
  statusCode: number;
}

export class AppError<TArgs extends unknown[] = []> extends BaseError {
  /**
   * The context object the factory was called with, retained.
   *
   * Every domain factory in this codebase takes a single
   * `context?: Record<string, any>` and uses it to build the message — and,
   * until this field existed, discarded it immediately afterwards. That worked
   * for anything a human reads, and failed for anything code needs to act on:
   * the mapping engine attaches `fault: AGENT | PLATFORM | PROVIDER`
   * to every mapping error precisely so the classifier can decide
   * whether the provider's stake is reachable, and the router can
   * decide whether to fail over — and none of them could read it back, because
   * by the time the error surfaced the attribution had been formatted into a
   * string and dropped.
   *
   * Deliberately **not** in `toJSON()`, and therefore not on the wire. A
   * context is internal detail — ids, amounts, upstream fragments — and
   * `AllExceptionsFilter` returns `{ code, message, statusCode, path,
   * timestamp }` and nothing else. This field is for a `catch` block, not for a
   * caller.
   */
  public readonly context?: Readonly<Record<string, unknown>>;

  constructor(definition: ErrorDefinition<TArgs>, ...args: TArgs) {
    const message = definition.message(...args);
    super(message, definition.code, definition.statusCode);

    const [first] = args;
    this.context = isContextObject(first) ? Object.freeze({ ...first }) : undefined;
  }
}

/**
 * Is the first factory argument the conventional context bag?
 *
 * Narrow on purpose. A factory whose `message` takes positional arguments
 * rather than a context object gets `undefined` here instead of having its
 * first argument silently reinterpreted as metadata.
 */
function isContextObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function createErrorFactory<const T extends Record<string, ErrorDefinition<any>>>(
  errors: T,
) {
  const factories = {} as {
    [K in keyof T]: (...args: Parameters<T[K]['message']>) => AppError<Parameters<T[K]['message']>>;
  };

  for (const key in errors) {
    const errorDef = errors[key];
    factories[key] = ((...args: unknown[]) =>
      new AppError(errorDef, ...args)) as (typeof factories)[typeof key];
  }

  return factories;
}
