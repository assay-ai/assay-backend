import { Module } from '@nestjs/common';

import { AuditLogWriter } from './audit-log-writer.service';

/**
 * Exports {@link AuditLogWriter}. Its only dependency is the `postgres`
 * data source, which `PostgresModule` provides globally.
 */
@Module({
  providers: [AuditLogWriter],
  exports: [AuditLogWriter],
})
export class AuditLogModule {}
