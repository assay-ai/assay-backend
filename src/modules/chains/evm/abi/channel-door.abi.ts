import { parseAbi } from 'viem';

/**
 * The channel door of `AssayEscrow` (assay-evm D-28/D-30, W1 commit 6e36571):
 * `src/AssayEscrow.sol` (the five doors and `channelBooks`) and the events of
 * `src/libraries/ChannelDoor.sol`, which run in the escrow's storage and as the
 * escrow's address (DELEGATECALL), so their logs carry the escrow's address.
 * Event shapes match `snapshots/events/AssayEscrow.events.txt` (indexed flags
 * included); `channel-door-abi.spec.ts` pins their topic hashes.
 *
 * `refundChannels` takes one `refundId` per item (sec-audit 2026-11-01 M-1): the
 * chain records it as used per lane and skips a reused one with
 * `ChannelRefundSkipped(..., AlreadyRefunded)`, moving no money, so a re-sent
 * refund can never refund the same call twice.
 *
 * ```solidity
 * struct ChannelVoucher { address payer; address provider; bytes32 channelId; uint64 cumulative;
 *                         uint32 calls; uint64 issuedAt; uint64 expiresAt; }
 * struct ChannelRef { address payer; address signer; address provider; bytes32 channelId; }
 * ```
 */
export const CHANNEL_DOOR_ABI = parseAbi([
  'struct ChannelVoucher { address payer; address provider; bytes32 channelId; uint64 cumulative; uint32 calls; uint64 issuedAt; uint64 expiresAt; }',
  'struct ChannelRef { address payer; address signer; address provider; bytes32 channelId; }',
  'function settleChannels(ChannelVoucher[] vs, bytes sigs, uint64[] fromSettled, uint64[] charges)',
  'function collectChannels(ChannelRef[] refs, uint64[] keepHeld)',
  'function refundChannels(ChannelRef[] refs, uint40[] buckets, uint64[] amounts, bytes32[] refundIds)',
  'function claimUnpaid(address to)',
  'function channelBooks(bytes32 key, address to) view returns (uint256 state, uint128 unpaid, uint128 totalUnpaid, uint128 held)',
  'event ChannelSettled(bytes32 indexed key, address indexed payer, address indexed provider, uint64 cumulative, uint32 calls, uint64 charge, uint24 maturityHour, uint16 takeRateBps)',
  'event ChannelOpened(bytes32 indexed key, address signer, bytes32 channelId)',
  'event ChannelBucketDeferred(bytes32 indexed key, uint24 fromHour, uint24 toHour, uint16 takeRateBps)',
  'event ChannelSettleSkipped(uint256 indexed index, address indexed payer, bytes32 key, uint64 cumulative, uint8 reason)',
  'event ChannelCollected(bytes32 indexed key, address indexed provider, uint24 maturityHour, uint64 gross, uint64 fee)',
  'event ChannelCollectSkipped(bytes32 indexed key, uint8 reason)',
  'event ChannelRefunded(bytes32 indexed key, address indexed payer, uint40 bucket, uint64 amount, bytes32 refundId)',
  'event ChannelRefundSkipped(bytes32 indexed key, uint40 bucket, uint64 amount, uint8 reason)',
  'event TransferDeferred(address indexed to, uint128 amount)',
  'event UnpaidClaimed(address indexed to, uint128 amount)',
]);

/**
 * `ChannelSettled` as the pre-W1 prototype (ab015cb) emitted it, with
 * `signer`, `channelId` and `waived`: read only to backfill keys opened under
 * that build on a dev or testnet chain (SPEC-W2 §2).
 */
export const LEGACY_CHANNEL_SETTLED_ABI = parseAbi([
  'event ChannelSettled(bytes32 indexed key, address indexed payer, address signer, address indexed provider, bytes32 channelId, uint64 cumulative, uint32 calls, uint64 charge, uint64 waived, uint24 m, uint16 r)',
]);

/**
 * The settlement token's issuer-freeze view, by its configured name
 * (`EVM_TOKEN_FREEZE_FUNCTIONS`): `function <name>(address) view returns (bool)`.
 */
export function TOKEN_FREEZE_ABI(name: string) {
  return parseAbi([`function ${name}(address account) view returns (bool)` as string]);
}
