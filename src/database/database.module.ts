import { Global, Module } from '@nestjs/common';
import { PostgresModule } from './postgres/postgres.module';

@Global()
@Module({
  imports: [PostgresModule],
  exports: [PostgresModule],
})
export class DatabaseModule {}
