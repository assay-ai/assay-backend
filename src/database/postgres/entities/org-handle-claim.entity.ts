import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** One handle claim or change, by the Privy user who made it — the claim gate's ledger. */
@Entity('org_handle_claims')
export class OrgHandleClaimEntity {
  @PrimaryGeneratedColumn('uuid', { name: 'id' })
  id: string;

  @Column({ name: 'org_id', type: 'uuid' })
  orgId: string;

  @Column({ name: 'privy_user_id', type: 'varchar', length: 128 })
  privyUserId: string;

  @Column({ name: 'handle', type: 'varchar', length: 24 })
  handle: string;

  @Column({ name: 'claimed_at', type: 'timestamptz' })
  claimedAt: Date;
}
