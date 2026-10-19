import { AlertSeverity } from '@shared/alerting';
import { OAUTH_MAX_LIVE_GRANTS_PER_AGENT } from '@modules/oauth/constants/oauth.constants';

/**
 * The alert thresholds of spec §6.7 for the OAuth signals, as dashboard
 * severities. Pure: each takes the numbers the collector read and returns the
 * breach, or `null` inside the healthy range. `MetricsCollectorService` turns
 * the result into the reading's gate, the same as the golden signals.
 */
export interface OAuthGateBreach {
  readonly severity: AlertSeverity;
  readonly summary: string;
}

/** §6.7: warn when one agent holds 45 or more live grants (the cap is 50). */
export const OAUTH_LIVE_GRANTS_PER_AGENT_WARN = OAUTH_MAX_LIVE_GRANTS_PER_AGENT - 5;

/** §6.7: `continue_cookie_missing` above 5 % of `approved`, over the trailing hour. */
export const OAUTH_CONTINUE_COOKIE_MISSING_WARN_RATIO = 0.05;

/**
 * §6.3.8: DCR registrations, all clients. Warn at 1000, not above it: 1000 is
 * also the default per-UTC-day cap, and reaching it is itself the event to
 * see, because DCR is then closed for everyone until 00:00 UTC. (The window
 * is the trailing 24 h, so up to about 2000 can show across a day boundary.)
 */
export const OAUTH_DCR_PER_DAY_WARN = 1000;

/** §6.3.8: DCR registrations per day under one `client_name`. */
export const OAUTH_DCR_PER_CLIENT_NAME_WARN = 100;

export function gateLiveGrantsPerAgent(maxPerAgent: number): OAuthGateBreach | null {
  if (maxPerAgent < OAUTH_LIVE_GRANTS_PER_AGENT_WARN) return null;
  return {
    severity: AlertSeverity.WARN,
    summary:
      `One agent holds ${maxPerAgent} live OAuth grants ` +
      `(warn at ${OAUTH_LIVE_GRANTS_PER_AGENT_WARN}, cap ${OAUTH_MAX_LIVE_GRANTS_PER_AGENT}).`,
  };
}

/** Any grant stopped for reuse is a possible stolen token: page. */
export function gateGrantsStoppedForReuse(stopped: number): OAuthGateBreach | null {
  if (stopped <= 0) return null;
  return {
    severity: AlertSeverity.CRITICAL,
    summary: `${stopped} OAuth grant(s) stopped for code or refresh-token reuse in 24h (alert on any).`,
  };
}

export function gateContinueCookieMissing(
  missingLastHour: number,
  approvedLastHour: number,
): OAuthGateBreach | null {
  if (missingLastHour <= 0) return null;
  if (missingLastHour <= approvedLastHour * OAUTH_CONTINUE_COOKIE_MISSING_WARN_RATIO) return null;
  return {
    severity: AlertSeverity.WARN,
    summary:
      `continue_cookie_missing ~${missingLastHour.toFixed(1)} against ~${approvedLastHour.toFixed(1)} ` +
      `approved in the last hour (warn above ${OAUTH_CONTINUE_COOKIE_MISSING_WARN_RATIO * 100}%).`,
  };
}

export function gateCimdBlockedAddress(blocked: number): OAuthGateBreach | null {
  if (blocked <= 0) return null;
  return {
    severity: AlertSeverity.WARN,
    summary: `${blocked} CIMD fetch(es) refused for a blocked address in 24h (alert on any).`,
  };
}

export function gateDcrRegistrations(
  perDay: number,
  maxPerClientName: number,
): OAuthGateBreach | null {
  const breaches: string[] = [];
  if (perDay >= OAUTH_DCR_PER_DAY_WARN) {
    breaches.push(`${perDay} DCR registrations in 24h (warn at ${OAUTH_DCR_PER_DAY_WARN})`);
  }
  if (maxPerClientName > OAUTH_DCR_PER_CLIENT_NAME_WARN) {
    breaches.push(
      `${maxPerClientName} under one client_name (warn above ${OAUTH_DCR_PER_CLIENT_NAME_WARN})`,
    );
  }
  if (breaches.length === 0) return null;
  return { severity: AlertSeverity.WARN, summary: `${breaches.join('; ')}.` };
}
