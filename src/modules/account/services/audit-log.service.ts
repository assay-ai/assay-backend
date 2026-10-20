import { Injectable } from '@nestjs/common';

import { AuditLogEntryEntity } from '@database/postgres/entities/audit-log-entry.entity';
import { AuditLogEntryRepository } from '@database/postgres/repositories/audit-log-entry.repository';
import { CursorPageDto, ListSpec, applyTimeWindow, asInstant, paginate } from '@shared/api';

import { AuditLogEntryDto, ListAuditLogQueryDto } from '../dto/list-audit-log.dto';
import { containsLikePattern } from '@shared/utils/like-pattern.util';

const AUDIT_LOG_LIST: ListSpec = {
  alias: 'entry',
  defaultSort: 'createdAt',
  sortable: {
    createdAt: {
      column: 'entry.created_at',
      type: 'timestamptz',
      valueOf: asInstant((row: AuditLogEntryEntity) => row.createdAt),
    },
  },
};

/**
 * `GET /api/v1/audit-log`. Read-only — see the DTO comment.
 */
@Injectable()
export class AuditLogService {
  constructor(private readonly auditLog: AuditLogEntryRepository) {}

  async list(
    organizationId: string,
    query: ListAuditLogQueryDto,
  ): Promise<CursorPageDto<AuditLogEntryDto>> {
    const qb = this.auditLog
      .createQueryBuilder('entry')
      .where('entry.organizationId = :organizationId', { organizationId });

    if (query.actorId) {
      qb.andWhere('entry.actorId = :actorId', { actorId: query.actorId });
    }
    if (query.action) {
      qb.andWhere('entry.action = :action', { action: query.action });
    }
    if (query.resourceType) {
      qb.andWhere('entry.resourceType = :resourceType', { resourceType: query.resourceType });
    }
    if (query.resourceId) {
      qb.andWhere('entry.resourceId = :resourceId', { resourceId: query.resourceId });
    }

    if (query.search) {
      // The screen's one box: "Actor, object or id".
      qb.andWhere(
        '(entry.actorId ILIKE :search OR entry.action ILIKE :search ' +
          'OR entry.resourceType ILIKE :search OR entry.resourceId ILIKE :search)',
        { search: containsLikePattern(query.search) },
      );
    }

    applyTimeWindow(qb, query, AUDIT_LOG_LIST);

    const page = await paginate(qb, query, AUDIT_LOG_LIST);
    return page.map((row) => this.toDto(row));
  }

  private toDto(entity: AuditLogEntryEntity): AuditLogEntryDto {
    return {
      id: entity.id,
      actorType: entity.actorType,
      actorId: entity.actorId,
      action: entity.action,
      resourceType: entity.resourceType,
      resourceId: entity.resourceId,
      before: entity.before,
      after: entity.after,
      ipAddress: entity.ipAddress,
      userAgent: entity.userAgent,
      requestId: entity.requestId,
      createdAt: entity.createdAt,
    };
  }
}
