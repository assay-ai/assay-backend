import { plainToClass } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ClassConstructor } from 'class-transformer/types/interfaces';

/**
 * Implicit conversion turns a string into a boolean with `Boolean(value)`, so
 * `FOO_ENABLED=false` would read as `true` and switch on every rule that is
 * conditional on it (e.g. "BULLBOARD_PASSWORD is required when enabled").
 * Parse the literal strings of boolean-typed fields first; anything else is
 * left to the usual conversion and validation.
 */
function parseBooleanFields<T extends object>(
  config: Record<string, unknown>,
  envVariablesClass: ClassConstructor<T>,
): Record<string, unknown> {
  const parsed = { ...config };
  for (const [key, value] of Object.entries(parsed)) {
    if (Reflect.getMetadata('design:type', envVariablesClass.prototype, key) !== Boolean) continue;
    if (value === 'true') parsed[key] = true;
    else if (value === 'false') parsed[key] = false;
  }
  return parsed;
}

export function validateConfig<T extends object>(
  config: Record<string, unknown>,
  envVariablesClass: ClassConstructor<T>,
) {
  const validatedConfig = plainToClass(
    envVariablesClass,
    parseBooleanFields(config, envVariablesClass),
    {
      enableImplicitConversion: true,
    },
  );

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    throw new Error(
      `Config validation error:\n${errors.map((err) => Object.values(err.constraints || {}).join(', ')).join('\n')}`,
    );
  }
  return validatedConfig;
}
