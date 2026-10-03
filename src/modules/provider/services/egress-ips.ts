import { ConfigService } from '@nestjs/config';

/**
 * The addresses a provider has to allowlist.
 *
 * ## Why this is configuration and not a lookup
 *
 * There is no way to ask a process what source address its packets will carry
 * after NAT — the answer belongs to the network the platform is deployed on,
 * not to the platform. So the list is declared by whoever deploys, and the
 * failure mode is a stale declaration rather than a wrong runtime answer. That
 * is the right trade here: a stale list produces a provider who allowlists
 * three addresses and sees the check pass from a fourth — visible, and
 * diagnosable from the check row, which stores the list it published
 * (`provider_connectivity_checks.egress_ips`).
 *
 * ## Empty is a real state and is not an error
 *
 * Unset means "we are not behind fixed egress addresses" — which is true of a
 * laptop and of most default cloud deployments. The console renders no
 * allowlist instruction in that case. Inventing a placeholder would be worse
 * than saying nothing: a provider who allowlists a fictional range has a
 * firewall rule that will never match and a check that passed anyway.
 */
export const PROVIDER_EGRESS_IPS = 'PROVIDER_EGRESS_IPS';

export function loadEgressIps(config: ConfigService): string[] {
  const raw = config.get<string>('PROVIDER_EGRESS_IPS') ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
