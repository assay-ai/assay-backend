/**
 * Whether the starter's reference modules are loaded.
 *
 * - `EXAMPLES_ENABLED` unset → on outside production, off when
 *   `NODE_ENV=production`. Sample routes must never appear on a production
 *   surface by default; forgetting to set a variable should fail closed.
 * - `EXAMPLES_ENABLED` set → the explicit value wins everywhere, so a
 *   production-like environment can still be used to inspect them deliberately.
 *
 * Call this INLINE in a bootstrap's `imports` array, after
 * `ConfigModule.forRoot(...)` — array elements evaluate in order, so the `.env`
 * file is loaded into `process.env` by the time this runs. Reading it into a
 * top-of-file constant resolves before `.env` loads and silently disables the
 * group (see "Bootstrap Registration" in `docs/architecture.md`).
 */
export function areExamplesEnabled(): boolean {
  const configured = process.env.EXAMPLES_ENABLED;

  if (configured !== undefined && configured !== '') {
    return configured === 'true';
  }

  return process.env.NODE_ENV !== 'production';
}
