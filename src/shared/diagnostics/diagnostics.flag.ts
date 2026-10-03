/**
 * Whether the diagnostics probe routes are mounted. Same fail-closed rule as
 * `areExamplesEnabled()`: unset means on outside production and off in it, an
 * explicit `DIAGNOSTICS_ENABLED` wins everywhere.
 *
 * Call INLINE in the bootstrap `imports` array, after `ConfigModule.forRoot`.
 */
export function areDiagnosticsEnabled(): boolean {
  const configured = process.env.DIAGNOSTICS_ENABLED;

  if (configured !== undefined && configured !== '') {
    return configured === 'true';
  }

  return process.env.NODE_ENV !== 'production';
}
