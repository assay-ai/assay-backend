import { Column, Entity, Index } from 'typeorm';
import { OrganizationScopedEntityWithoutSoftDelete } from './organization-scoped.entity';

/**
 * A deposit intent — one rail-A `exact` payment into the treasury vault.
 * Deliberately a sibling table of `payment_intents`, not a member of it: see
 * the header of `src/modules/payment/ports/deposit.types.ts` for why.
 *
 * Never soft-deleted, same reasoning as `PaymentIntentEntity` — this is a
 * financial record, and a deleted one is a reconciliation hole.
 */
@Entity('deposit_intents')
@Index('idx_deposit_intents_status_expires_at', ['status', 'expiresAt'])
@Index('idx_deposit_intents_agent', ['organizationId', 'agentId'])
export class DepositIntentEntity extends OrganizationScopedEntityWithoutSoftDelete {
  /** One of `DepositIntentStatus`; the CHECK constraint holds the enum. */
  @Column({ name: 'status', type: 'varchar', length: 16 })
  status: string;

  /** Why it last moved. The expiry sweep and the settlement path both write here. */
  @Column({ name: 'status_reason', type: 'varchar', length: 256, nullable: true })
  statusReason: string | null;

  @Column({ name: 'agent_id', type: 'uuid' })
  agentId: string;

  /** CAIP-10. The ledger account credited once settlement is observed. */
  @Column({ name: 'agent_account', type: 'varchar', length: 256 })
  agentAccount: string;

  /** Always the chain's registered USDC — enforced in code before the row exists, not by a CHECK here. */
  @Column({ name: 'asset_id', type: 'varchar', length: 256 })
  assetId: string;

  @Column({ name: 'decimals', type: 'int' })
  decimals: number;

  /** What the `402` requirements advertised. */
  @Column({ name: 'requested_amount', type: 'numeric', precision: 78, scale: 0 })
  requestedAmount: string;

  /** What actually landed, once observed on chain. May exceed `requested_amount` on SVM. */
  @Column({ name: 'settled_amount', type: 'numeric', precision: 78, scale: 0, nullable: true })
  settledAmount: string | null;

  @Column({ name: 'chain_id', type: 'varchar', length: 128 })
  chainId: string;

  /** The settlement transaction signature, once known. */
  @Column({ name: 'chain_tx_ref', type: 'varchar', length: 256, nullable: true })
  chainTxRef: string | null;

  /** Short — bounded by the SVM blockhash the client's transaction is signed over. */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  /**
   * When the finality sweep resolved this deposit — `DEPOSIT_CONFIRM` or
   * `DEPOSIT_REJECT` appended to the journal.
   *
   * **A queue marker, not the record.** The journal stays authoritative for
   * which of the two happened, and `DepositFinalityService` still reads it
   * before writing. This column exists so a resolved deposit leaves
   * `findSettledAwaitingFinality`'s candidate set instead of occupying it
   * forever — see `DepositFinalityResolution1758100000001` for the sweep that
   * silently stopped reaching new deposits without it. Same role as
   * `payment_intents.hold_released_at` on the sibling table.
   */
  @Column({ name: 'finality_resolved_at', type: 'timestamptz', nullable: true })
  finalityResolvedAt: Date | null;
}
