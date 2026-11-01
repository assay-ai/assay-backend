/**
 * The channel voucher's shape, EIP-712 type, key and slot helpers. They live
 * with the chain code (`chains/evm/eip712/channel-voucher.ts`, the only place a
 * chain SDK may be imported); the payment domain reads them from here.
 */
export * from '@modules/chains/evm/eip712/channel-voucher';
