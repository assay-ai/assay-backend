import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { AuditActor, AuditLogWriter } from '@shared/audit';

import type { ReceiptPrivacyDto } from '../dto/receipt-privacy.dto';

/**
 * The per-organization switch behind the public receipt page
 * (`organizations.receipts_public`, on by default). Reading and changing it is
 * the account owner's: the controller admits a person's session only.
 */
@Injectable()
export class ReceiptPrivacyService {
  constructor(
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly audit: AuditLogWriter,
  ) {}

  async get(organizationId: string): Promise<ReceiptPrivacyDto> {
    const rows: Array<{ receipts_public: boolean }> = await this.dataSource.query(
      'SELECT receipts_public FROM organizations WHERE id = $1',
      [organizationId],
    );
    // An organization row always exists for a signed-in session; default to the product default if not.
    return { receiptsPublic: rows[0]?.receipts_public ?? true };
  }

  /** Sets the switch and writes the audit entry in the same transaction: no change without its entry. */
  async set(
    organizationId: string,
    receiptsPublic: boolean,
    actor: AuditActor,
  ): Promise<ReceiptPrivacyDto> {
    await this.dataSource.transaction(async (manager) => {
      const rows: Array<{ receipts_public: boolean }> = await manager.query(
        'SELECT receipts_public FROM organizations WHERE id = $1 FOR UPDATE',
        [organizationId],
      );
      const before = rows[0]?.receipts_public ?? true;
      if (before === receiptsPublic) return;
      await manager.query('UPDATE organizations SET receipts_public = $2 WHERE id = $1', [
        organizationId,
        receiptsPublic,
      ]);
      await this.audit.record(manager, {
        organizationId,
        actor,
        action: 'receipt_privacy.updated',
        resourceType: 'organization',
        resourceId: organizationId,
        before: { receipts_public: before },
        after: { receipts_public: receiptsPublic },
      });
    });
    return { receiptsPublic };
  }
}
