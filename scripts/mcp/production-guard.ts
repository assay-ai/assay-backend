/**
 * Refuses in production. `scripts/mcp/policies.ts` promotes policies on
 * fabricated evidence; on a real deployment a policy is switched on through
 * the operator console (P-1), on counts the server measures.
 */
export function assertNotProduction(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === 'production') {
    throw new Error(
      'scripts/mcp/policies.ts fabricates promotion evidence and does not run with ' +
        'NODE_ENV=production; switch a policy on through the operator console instead',
    );
  }
}
