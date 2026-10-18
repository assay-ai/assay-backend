import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const TYPEORM_MODULE_OPTIONS: Partial<TypeOrmModuleOptions> = {
  maxQueryExecutionTime: 200,
};
