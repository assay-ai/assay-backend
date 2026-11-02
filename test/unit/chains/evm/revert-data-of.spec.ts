import { ContractFunctionRevertedError } from 'viem';

import { evmErrorName, revertDataOf } from '../../../../src/modules/chains/evm/abi/error-selectors';

describe('revertDataOf', () => {
  it('reads a custom error from viem when the ABI declares no errors', () => {
    // `AddressBlocked()`: viem keeps the bytes in `raw` and the selector in `signature`.
    const error = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'redeem',
      data: '0xae170cc2',
    });
    expect((error as { data?: unknown }).data).toBeUndefined();
    expect(evmErrorName(revertDataOf(error))).toBe('AddressBlocked');
  });

  it('finds the selector under a wrapping error', () => {
    const inner = new ContractFunctionRevertedError({
      abi: [],
      functionName: 'redeem',
      data: '0xae170cc2',
    });
    expect(evmErrorName(revertDataOf({ message: 'call failed', cause: inner }))).toBe(
      'AddressBlocked',
    );
  });

  it('still prefers typed `data`, and ignores prose', () => {
    expect(revertDataOf({ data: '0xAE170CC2' })).toBe('0xae170cc2');
    expect(revertDataOf({ data: 'execution reverted', signature: 'nope' })).toBeNull();
  });
});
