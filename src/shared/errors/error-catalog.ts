import { createErrorFactory, ErrorDefinition } from './app-errors';

/**
 * Every domain owns a prefix. A code without its domain's prefix is one you
 * cannot grep, cannot route an alert on, and cannot tell apart from another
 * domain's code when reading a receipt six months later.
 *
 * The prefix is enforced twice, deliberately:
 *
 * 1. **At compile time** — each catalog declares
 *    `export type _ = AssertDomainErrorCodes<'PAYMENT', `${PaymentErrorCode}`>`.
 *    The template-literal conversion turns the enum into its string-literal
 *    union, so a member added without the prefix fails `yarn build`.
 * 2. **At import time** — `createDomainErrorFactory` re-checks the runtime
 *    values, which catches a hand-written string that bypassed the enum.
 */
export type AssertDomainErrorCodes<
  TPrefix extends string,
  TCodes extends `${TPrefix}_${string}`,
> = TCodes;

/**
 * Builds a module's error factory and asserts every code carries `prefix`.
 *
 * Throws while the module is being imported, so a mis-prefixed code fails the
 * process at boot rather than on the first request that happens to raise it.
 */
export function createDomainErrorFactory<const T extends Record<string, ErrorDefinition<any>>>(
  prefix: string,
  errors: T,
) {
  for (const key of Object.keys(errors)) {
    const { code } = errors[key];
    if (!code.startsWith(`${prefix}_`)) {
      throw new Error(
        `Error catalog violation: "${key}" declares code "${code}" but this catalog is prefixed "${prefix}_"`,
      );
    }
  }

  return createErrorFactory(errors);
}
