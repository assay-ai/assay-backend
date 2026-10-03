import { Injectable } from '@nestjs/common';

import { EscrowOpenerPort } from '@modules/payment/ports/escrow-opener.port';

import { AccountId, AssetId } from '../ports/caip.types';
import { EvmEscrowBalanceReader } from './evm-escrow-balance-reader.service';

/**
 * `EscrowOpenerPort` on `eip155` — **there is nothing to open**, and that is
 * the whole implementation.
 *
 * ## Why the port still has an EVM member rather than the caller skipping it
 *
 * `ESCROW_OPENER` was bound `useExisting: SolanaEscrowOpener`, unconditionally,
 * and `DepositService.ensureEscrow` calls it for every buyer with no mirror
 * row. Measured against the running API on `eip155:46630` — after the deposit
 * asset was fixed and before this class existed:
 *
 * ```text
 * 409 PAYMENT_ESCROW_NOT_OPEN
 * "No escrow is open for this account: eip155:46630:0x9965…A4dc
 *  (Invalid value 0x9965…A4dc for base 58 with alphabet 123456789ABC…)"
 * ```
 *
 * A base58 decoder was handed an `0x` address. The alternative fix — teaching
 * `DepositService` that some chains need no escrow opened — puts a per-chain
 * fact in the chain-neutral service, which is the arrangement every other port
 * in this module exists to avoid. The dispatch belongs in the multiplexer and
 * the answer belongs here.
 *
 * ## Why "nothing to open" is the truth on this chain and not a stub
 *
 * Solana's escrow is a PDA that must be `init`ed before its associated token
 * account can exist, and the rent has to come from somewhere — hence a real
 * `open_escrow` transaction, a fee payer, and a `signature` to record. EVM's is
 * a `mapping(address => Escrow)` inside one already-deployed contract: the
 * buyer's row springs into existence when `depositFor` first writes it, there
 * is no account to create, no rent to advance, and no transaction that could be
 * sent to "open" one. So this returns the deployment's escrow address — the
 * same address `EscrowBalanceReaderPort` answers with for every buyer on the
 * chain — with `signature: null`, which the port already declares for "could
 * not be confirmed" and which `buyer_escrows.opened_tx_ref` is already nullable
 * for.
 *
 * The addresses come from {@link EvmEscrowBalanceReader.escrowAddresses} rather
 * than from a second read of `EVM_DEPLOYMENTS`, so the address a deposit is
 * told about and the address a balance is read from cannot diverge. That method
 * also carries the two refusals this path needs and would otherwise have to
 * repeat: an unserved chain (`CHAIN_UNSUPPORTED`), a malformed buyer address
 * (`CHAIN_INVALID_ADDRESS`) and an asset that is not the chain's
 * (`CHAIN_ASSET_NOT_ON_CHAIN`).
 *
 * ## What this class deliberately does not hold
 *
 * No relayer, no key, no `sendRawTransaction`. `SolanaEscrowOpener` resolves a
 * fee payer through `ModuleRef` precisely so a process with no business paying
 * for an open cannot; the EVM member reaches the same guarantee by having
 * nothing to send.
 */
@Injectable()
export class EvmEscrowOpener implements EscrowOpenerPort {
  constructor(private readonly escrows: EvmEscrowBalanceReader) {}

  async open(
    buyer: AccountId,
    asset: AssetId,
  ): Promise<{
    readonly escrowPda: AccountId;
    readonly escrowTokenAccount: AccountId;
    readonly signature: string | null;
  }> {
    const { escrowPda, escrowTokenAccount } = await this.escrows.escrowAddresses(buyer, asset);
    return { escrowPda, escrowTokenAccount, signature: null };
  }
}
