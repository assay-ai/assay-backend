import { ValidateBy, ValidationOptions } from 'class-validator';

import { MONEY_MAX_ATOMIC_UNITS } from '@shared/utils/money.util';

const DIGITS_RE = /^\d{1,78}$/;

/**
 * Atomic units as a non-negative decimal integer string that `MoneyUtil.of`
 * will accept: digits only, and at most {@link MONEY_MAX_ATOMIC_UNITS} (u64).
 *
 * A digits-only regex is not enough on a field that is stored and later read
 * back through `MoneyUtil`: a 21–78 digit value passes the regex, is written,
 * and then every read of the row throws `amountOverflow` — the caller has
 * bricked their own record. The range belongs at the edge, next to the grammar.
 */
export function IsAtomicAmount(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isAtomicAmount',
      validator: {
        validate: (value: unknown): boolean =>
          typeof value === 'string' &&
          DIGITS_RE.test(value) &&
          BigInt(value) <= MONEY_MAX_ATOMIC_UNITS,
        defaultMessage: (args) =>
          `${args?.property} must be a decimal integer string of atomic units, at most ${MONEY_MAX_ATOMIC_UNITS}`,
      },
    },
    options,
  );
}
