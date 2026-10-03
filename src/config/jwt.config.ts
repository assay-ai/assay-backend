import { registerAs } from '@nestjs/config';
import { validateConfig } from '@shared/utils/validate-config';
import { IsNotEmpty, IsString, IsOptional } from 'class-validator';

class JwtEnvVariables {
  @IsString()
  @IsNotEmpty()
  JWT_SECRET: string;

  @IsString()
  @IsOptional()
  JWT_EXPIRES_IN?: string;
}

export const jwtConfig = registerAs('jwt', () => {
  validateConfig(process.env, JwtEnvVariables);

  return {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    signOptions: {
      algorithm: 'HS256' as const,
    },
  };
});
