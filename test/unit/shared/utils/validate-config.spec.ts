import 'reflect-metadata';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { validateConfig } from '@shared/utils/validate-config';

// Same shape as BullBoardEnvVariables and the alert sinks: a value that is
// required only while a boolean switch is on.
class SwitchedEnv {
  @IsBoolean()
  @IsOptional()
  FEATURE_ENABLED?: boolean;

  @ValidateIf((o) => o.FEATURE_ENABLED === true || o.FEATURE_ENABLED === 'true')
  @IsString()
  @IsNotEmpty()
  FEATURE_SECRET?: string;
}

describe('validateConfig', () => {
  it('reads FEATURE_ENABLED=false as off, so the switched value is not required', () => {
    expect(() => validateConfig({ FEATURE_ENABLED: 'false' }, SwitchedEnv)).not.toThrow();
    expect(validateConfig({ FEATURE_ENABLED: 'false' }, SwitchedEnv).FEATURE_ENABLED).toBe(false);
  });

  it('reads FEATURE_ENABLED=true as on and requires the switched value', () => {
    expect(() => validateConfig({ FEATURE_ENABLED: 'true' }, SwitchedEnv)).toThrow(
      /Config validation error/,
    );
    expect(() =>
      validateConfig({ FEATURE_ENABLED: 'true', FEATURE_SECRET: 's' }, SwitchedEnv),
    ).not.toThrow();
  });

  it('leaves an unset switch unset', () => {
    expect(() => validateConfig({}, SwitchedEnv)).not.toThrow();
  });

  it('does not turn "false" into a boolean for a string field', () => {
    const out = validateConfig({ FEATURE_ENABLED: 'true', FEATURE_SECRET: 'false' }, SwitchedEnv);
    expect(out.FEATURE_SECRET).toBe('false');
  });
});
