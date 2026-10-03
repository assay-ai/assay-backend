import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';

/**
 * The seam between a window closing in breach and a case existing.
 *
 * SLA strike recording writes `sla_strikes` and leaves `status = 'RECORDED'`
 * with nothing to move it; this port is what moves it. It exists for the same
 * reason `SLA_WINDOW_POSTER` does: `SlaWindowService` lives in
 * the provider domain and the proposal lifecycle lives in the slash domain, and
 * a direct import would make `SlaWindowModule` — a module whose whole purpose
 * is to keep `VerificationModule` acyclic — depend on the module that depends
 * on the operator identity, the chain executor and the override log.
 *
 * One method, taking the strike it already has in hand. Returning `void`
 * rather than the proposal is deliberate: a caller that can branch on the
 * proposal will eventually branch on it, and whether a finding becomes a case
 * is the slash domain's business, not the window's.
 */
export interface SlashProposalOpenerPort {
  openFromStrike(strike: SlaStrikeEntity): Promise<void>;
}

export const SLASH_PROPOSAL_OPENER = 'SLASH_PROPOSAL_OPENER';
