import { AccountId } from '@modules/chains/ports/caip.types';

/**
 * Whether the payer's escrow makes a TIGHTENING wait before it binds (assay-evm
 * D-21, "signed means collectable").
 *
 * On an escrow that has it, revoking a delegate, shortening its horizon or
 * lowering a delegate's or the escrow's caps binds a voucher that was already
 * valid only `TIGHTEN_DELAY_SECONDS` (10,800 s since D-24) later — longer than
 * any voucher stays redeemable there (7,620 s). Nothing the payer does can then strand a served
 * payment, so the strand guard (`UnsettledVoucherGuard`: refuse unless
 * acknowledged, pause admission while relayed) has nothing left to protect.
 *
 * `false` whenever it is not KNOWN to be there: a chain without it (Solana, an
 * escrow not yet upgraded) or one that could not be asked. `false` keeps the
 * guard, which is the strict side.
 */
export interface TightenDelayPort {
  holdsTightening(payer: AccountId): Promise<boolean>;
}

export const TIGHTEN_DELAY = 'TIGHTEN_DELAY';
