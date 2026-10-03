import { validateConfig } from '@shared/utils/validate-config';
import { registerAs } from '@nestjs/config';
import { IsNotEmpty, IsNumber, IsOptional, IsString } from 'class-validator';

class RedisEvnVariables {
  @IsString()
  @IsNotEmpty()
  REDIS_HOST: string;

  @IsNumber()
  @IsNotEmpty()
  REDIS_PORT: number;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD: string;

  @IsString()
  @IsNotEmpty()
  REDIS_URL: string;
}

const redisConfig = registerAs('redis', () => {
  validateConfig(process.env, RedisEvnVariables);

  return {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT, 10),
    password: process.env.REDIS_PASSWORD,
    url: process.env.REDIS_URL,
  };
});

export { redisConfig };
