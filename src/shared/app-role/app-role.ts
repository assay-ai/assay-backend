/**
 * Which app this Nest container serves: the MCP host or the dashboard API.
 *
 * A DI token rather than an environment variable, because `SERVICE_TYPE=all`
 * runs the API and MCP bootstraps in one process (`src/main.ts`): one
 * `process.env`, two containers. Each app module imports
 * `AppRoleModule.forRoot(role)`, so the value is per container.
 *
 * It matters where the two apps must differ on the same credential: the API
 * app accepts OAuth grants of payment clients only (spec §6.3.13).
 */
export type AppRole = 'mcp' | 'api';

export const APP_ROLE = Symbol('APP_ROLE');

/**
 * What a container without `AppRoleModule` gets: `'api'`, the strict side,
 * so a forgotten import refuses more rather than admits more.
 */
export const DEFAULT_APP_ROLE: AppRole = 'api';

/**
 * Inject as `@Optional() @Inject(APP_ROLE) role?: AppRole`, then
 * `resolveAppRole(role)`.
 */
export function resolveAppRole(role: AppRole | undefined | null): AppRole {
  return role ?? DEFAULT_APP_ROLE;
}
