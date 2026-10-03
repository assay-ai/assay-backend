/**
 * DI tokens local to the facilitator process. Mirrors `solana.constants.ts`'s
 * `SOLANA_RPC` token, deliberately not reused from it — the facilitator is its
 * own process (it isolates the fee-payer key) and should not share a provider
 * graph with `ChainsModule`.
 */
export const FACILITATOR_SOLANA_RPC = 'FACILITATOR_SOLANA_RPC';
