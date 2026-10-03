import { BaseError } from '@shared/errors/base.error';

/**
 * Asserts `fn` throws an `AppError` carrying exactly `code`.
 *
 * `expect(fn).toThrow(...)` can only match a message or a class, and every
 * domain error shares one class — matching on the message would tie the test to
 * prose. The code is the contract.
 */
export function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected error "${code}" but the call returned normally`);
  }

  expect(thrown).toBeInstanceOf(BaseError);
  expect((thrown as BaseError).errorCode).toBe(code);
}

/** Promise-returning counterpart of `expectErrorCode`. */
export async function expectErrorCodeAsync(
  fn: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let thrown: unknown;
  try {
    await fn();
  } catch (error) {
    thrown = error;
  }

  if (thrown === undefined) {
    throw new Error(`Expected error "${code}" but the call resolved`);
  }

  expect(thrown).toBeInstanceOf(BaseError);
  expect((thrown as BaseError).errorCode).toBe(code);
}
