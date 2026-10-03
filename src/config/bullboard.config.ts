import { registerAs } from '@nestjs/config';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { validateConfig } from '@shared/utils/validate-config';

/**
 * Bull Board dashboard configuration.
 *
 * Mounted on the API server at `${global-prefix}${BULLBOARD_PATH}` (e.g.
 * `/api/admin/queues`) and protected with HTTP basic auth. Network-level
 * restrictions (firewall, IP allowlist, VPN) are handled by infra, not here.
 *
 * Fail-fast contract: if `BULLBOARD_ENABLED=true` then `BULLBOARD_PASSWORD`
 * MUST be set. There is intentionally NO default password — leaking a default
 * `admin/admin123` to production is a known antipattern.
 */
class BullBoardEnvVariables {
  @IsBoolean()
  @IsOptional()
  BULLBOARD_ENABLED?: boolean;

  @IsString()
  @IsOptional()
  BULLBOARD_PATH?: string;

  @IsString()
  @IsOptional()
  BULLBOARD_USERNAME?: string;

  // Required only when Bull Board is enabled. No default — fail loud at boot
  // rather than silently expose the dashboard with a guessable credential.
  // `@IsNotEmpty` matters as much as `@IsString`: `BULLBOARD_PASSWORD=` in a
  // .env sets an empty string, which is "set" as far as dotenv and @IsString
  // are concerned, and would mount the dashboard behind a blank password.
  @ValidateIf((o) => o.BULLBOARD_ENABLED === true || o.BULLBOARD_ENABLED === 'true')
  @IsString({ message: 'BULLBOARD_PASSWORD is required when BULLBOARD_ENABLED=true' })
  @IsNotEmpty({ message: 'BULLBOARD_PASSWORD must not be empty when BULLBOARD_ENABLED=true' })
  BULLBOARD_PASSWORD?: string;
}

export const bullboardConfig = registerAs('bullboard', () => {
  validateConfig(process.env, BullBoardEnvVariables);

  return {
    enabled: process.env.BULLBOARD_ENABLED === 'true',
    path: process.env.BULLBOARD_PATH || '/admin/queues',
    username: process.env.BULLBOARD_USERNAME || 'admin',
    password: process.env.BULLBOARD_PASSWORD,
  };
});
