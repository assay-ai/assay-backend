import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const TYPEORM_MODULE_OPTIONS: Partial<TypeOrmModuleOptions> = {
  logger: 'formatted-console',
  maxQueryExecutionTime: 200,
};
