import { validateConfig } from '@shared/utils/validate-config';
import { registerAs } from '@nestjs/config';
import { IsBoolean, IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

class DatabaseEvnVariables {
  @IsString()
  @IsNotEmpty()
  DATABASE_HOST: string;

  @IsNumber()
  @IsNotEmpty()
  DATABASE_PORT: number;

  @IsString()
  @IsNotEmpty()
  DATABASE_USER: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  DATABASE_NAME: string;

  @IsBoolean()
  @IsOptional()
  DATABASE_LOGGING?: boolean;
}

const databaseConfig = registerAs('database', () => {
  validateConfig(process.env, DatabaseEvnVariables);

  return {
    host: process.env.DATABASE_HOST,
    port: parseInt(process.env.DATABASE_PORT, 10),
    username: process.env.DATABASE_USER,
    password: process.env.DATABASE_PASSWORD,
    database: process.env.DATABASE_NAME,
    logging: process.env.DATABASE_LOGGING === 'true',
  };
});

export { databaseConfig };
