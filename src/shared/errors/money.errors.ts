import { AssertDomainErrorCodes, createDomainErrorFactory } from './error-catalog';

/**
 * `MONEY_*` — arithmetic on `Money`.
 *
 * Shared rather than owned by a domain module, for the same reason
 * `ORGANIZATION_*` is: every domain does arithmetic on money, and a fee
 * calculation that overflows in the settlement module must fail with the same
 * code as one that overflows in the ledger.
 *
 * These are all `500`-adjacent in spirit — they mean a caller handed `MoneyUtil`
 * something it promised not to — but they are reported as `400` because the
 * value almost always originated in a request body.
 */
export enum MoneyErrorCode {
  MONEY_AMOUNT_NOT_AN_INTEGER = 'MONEY_AMOUNT_NOT_AN_INTEGER',
  MONEY_AMOUNT_OVERFLOW = 'MONEY_AMOUNT_OVERFLOW',
  MONEY_AMOUNT_UNDERFLOW = 'MONEY_AMOUNT_UNDERFLOW',
  MONEY_INVALID_DECIMALS = 'MONEY_INVALID_DECIMALS',
  MONEY_INVALID_ASSET = 'MONEY_INVALID_ASSET',
  MONEY_INVALID_RATE = 'MONEY_INVALID_RATE',
  MONEY_INVALID_DIVISOR = 'MONEY_INVALID_DIVISOR',
  MONEY_DIVISION_BY_ZERO = 'MONEY_DIVISION_BY_ZERO',
  MONEY_ASSET_MISMATCH = 'MONEY_ASSET_MISMATCH',
  MONEY_DECIMALS_MISMATCH = 'MONEY_DECIMALS_MISMATCH',
  MONEY_ASSET_UNKNOWN = 'MONEY_ASSET_UNKNOWN',
}

export type MoneyErrorCodesArePrefixed = AssertDomainErrorCodes<'MONEY', `${MoneyErrorCode}`>;

export const MoneyErrors = createDomainErrorFactory('MONEY', {
  amountNotAnInteger: {
    code: MoneyErrorCode.MONEY_AMOUNT_NOT_AN_INTEGER,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Money must be a whole number of atomic units, given as a string or bigint; received ` +
      `${context?.type ?? 'value'} ${JSON.stringify(context?.value)}`,
  },
  amountOverflow: {
    code: MoneyErrorCode.MONEY_AMOUNT_OVERFLOW,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Amount ${context?.value} exceeds the maximum representable ${context?.max} atomic units` +
      `${context?.operation ? ` (${context.operation})` : ''}`,
  },
  amountUnderflow: {
    code: MoneyErrorCode.MONEY_AMOUNT_UNDERFLOW,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Amount ${context?.value} is below zero; Money is never negative` +
      `${context?.operation ? ` (${context.operation})` : ''}`,
  },
  invalidDecimals: {
    code: MoneyErrorCode.MONEY_INVALID_DECIMALS,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Decimals must be a whole number between 0 and ${context?.max}; received ${context?.value}`,
  },
  invalidAsset: {
    code: MoneyErrorCode.MONEY_INVALID_ASSET,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Money must carry a CAIP-19 asset id; received "${context?.value}"`,
  },
  invalidRate: {
    code: MoneyErrorCode.MONEY_INVALID_RATE,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `A rate must be a whole, non-negative number of basis points; received ${context?.value}`,
  },
  invalidDivisor: {
    code: MoneyErrorCode.MONEY_INVALID_DIVISOR,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `A divisor must be a whole number greater than zero; received ${context?.value}`,
  },
  divisionByZero: {
    code: MoneyErrorCode.MONEY_DIVISION_BY_ZERO,
    statusCode: 400,
    message: () => 'Division of Money by zero',
  },
  assetMismatch: {
    code: MoneyErrorCode.MONEY_ASSET_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Cannot combine ${context?.left} with ${context?.right}; two Money values must be the same asset`,
  },
  decimalsMismatch: {
    code: MoneyErrorCode.MONEY_DECIMALS_MISMATCH,
    statusCode: 400,
    message: (context?: Record<string, any>) =>
      `Asset ${context?.asset} was presented with ${context?.left} decimals and ` +
      `${context?.right} decimals in the same operation`,
  },
  assetUnknown: {
    code: MoneyErrorCode.MONEY_ASSET_UNKNOWN,
    statusCode: 400,
    message: () => 'Cannot produce Money without an asset; an empty sum has no asset to carry',
  },
});
