import { Inject, Injectable, Logger } from '@nestjs/common';

import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { AccountId, isAccountId, isChainId } from '@modules/chains/ports/caip.types';
import { ALERT_PORT, AlertAggregation, AlertPort, AlertSeverity } from '@shared/alerting';

import {
  ChainEnrolment,
  ChainEnrolmentPort,
  ChainEnrolmentStatus,
  enrolmentKey,
} from '../ports/chain-enrolment.port';

const STATUSES: ReadonlySet<string> = new Set<string>(Object.values(ChainEnrolmentStatus));

/** Why a row could not be turned into an enrolment. Also the alert's dedupe grain. */
export enum UnreadableEnrolmentReason {
  MALFORMED_CHAIN_OR_PAYOUT = 'MALFORMED_CHAIN_OR_PAYOUT',
  UNKNOWN_STATUS = 'UNKNOWN_STATUS',
  MALFORMED_STAKE_AUTHORITY = 'MALFORMED_STAKE_AUTHORITY',
}

/** One row that was dropped, and why. Carried out of the mapper so the caller can alert once. */
interface UnreadableRow {
  readonly organizationId: string;
  readonly chainId: string;
  readonly reason: UnreadableEnrolmentReason;
}

/**
 * Enrolments out of `provider_chain_enrolments`.
 *
 * One statement per routing decision, over every candidate provider at once —
 * the same shape as `DbStakeGraceSource`, and scoped for the same reason: the
 * candidate set already names every organization the read is about.
 *
 * ## It maps, and it does not decide
 *
 * The row is turned into a {@link ChainEnrolment} and nothing else happens to
 * it. No default is synthesised for a provider with no row, no row is dropped
 * for having a null stake authority, and the stake behind
 * `stakeAuthorityAccountId` is not read here — an enrolment is a declaration,
 * and reading the collateral against it is the stake gate's job on every
 * decision. A source that consulted the chain would make the gate read its own
 * answer back as an input.
 *
 * ## A row it cannot type is dropped, and that is loud
 *
 * Dropping is fail-closed and correct: an absent enrolment means "not enrolled
 * on that chain", and on money "I do not understand this row" must mean "do not
 * pay". But the *consequence* is that a provider silently leaves the market —
 * they stop being routed, stop earning, and their payout address becomes
 * unreadable — and the only condition that can produce it is a deployment
 * mid-drift, which is exactly when nobody is watching the log. So it goes
 * through {@link AlertPort} as well as the log: one alert per read that dropped
 * anything, `ONCE_PER_INCIDENT` per reason so a drifted schema pages three
 * times an hour rather than once per routing decision.
 */
@Injectable()
export class DbChainEnrolmentSource implements ChainEnrolmentPort {
  private readonly logger = new Logger(DbChainEnrolmentSource.name);

  constructor(
    private readonly enrolments: ProviderChainEnrolmentRepository,
    @Inject(ALERT_PORT) private readonly alerts: AlertPort,
  ) {}

  async enrolmentsOf(providerIds: readonly string[]): Promise<ReadonlyMap<string, ChainEnrolment>> {
    const found = new Map<string, ChainEnrolment>();
    if (providerIds.length === 0) return found;

    const rows = await this.enrolments.findByProviders([...new Set(providerIds)]);

    const unreadable: UnreadableRow[] = [];
    for (const row of rows) {
      const enrolment = this.toEnrolment(row, unreadable);
      if (enrolment === null) continue;
      found.set(enrolmentKey(enrolment.providerId, enrolment.chainId), enrolment);
    }

    // Awaited, not fired and forgotten, and only on a path that is unreachable
    // through the schema: by the time this runs the market is already wrong, so
    // the few milliseconds are the cheapest thing in the failure.
    await this.alert(unreadable);

    return found;
  }

  /**
   * One alert per reason, naming the providers that vanished.
   *
   * `CRITICAL` because the observable effect is a provider dropping out of
   * routing and out of earnings, which `AlertSeverity` defines as money being
   * wrong. `ONCE_PER_INCIDENT` keyed on the reason because the condition is a
   * *schema* state, not an event: it will be true on every routing decision
   * until somebody deploys, and paging per decision would teach the channel to
   * be ignored — the failure mode `alertport-dedup-fix` exists to prevent.
   */
  private async alert(unreadable: readonly UnreadableRow[]): Promise<void> {
    if (unreadable.length === 0) return;

    for (const reason of new Set(unreadable.map((row) => row.reason))) {
      const affected = unreadable.filter((row) => row.reason === reason);
      await this.alerts.emit({
        severity: AlertSeverity.CRITICAL,
        name: 'chain_enrolment_unreadable',
        summary:
          `${affected.length} provider_chain_enrolments row(s) could not be read (${reason}) and ` +
          `were dropped — those providers are not routable on those chains`,
        details: {
          reason,
          rows: affected.length,
          providers: [...new Set(affected.map((row) => row.organizationId))].join(','),
          chains: [...new Set(affected.map((row) => row.chainId))].join(','),
        },
        aggregation: AlertAggregation.ONCE_PER_INCIDENT,
        dedupeKey: reason,
      });
    }
  }

  /**
   * One row, or `null` if it is not an enrolment this process can act on.
   *
   * Three CHECK constraints already hold the chain id, the account ids and the
   * status to these shapes, so `null` here should be unreachable — which is
   * exactly why the alternative was a cast. A cast would have made the branded
   * types a claim about the schema rather than a fact about the value, and the
   * first row written by something that bypassed the constraints (a `COPY`, a
   * restore from a dump taken before them, a future migration that widens the
   * status vocabulary before this file learns the new word) would travel into
   * the router as a well-typed lie.
   *
   * The validators are `isChainId` / `isAccountId` — the **grammar**
   * `caip.types.ts` parses — and never a colon count. `s:a:b`, `SOLANA:X:Y`
   * and a 400-character address all have the right number of colons and are
   * none of them account ids; a colon count would brand all three, which is the
   * same well-typed lie a cast makes, spelled longer. `test/unit/provider/
   * chain-enrolment.spec.ts` pins that distinction with strings chosen to pass
   * a colon count and fail the grammar.
   */
  private toEnrolment(
    row: ProviderChainEnrolmentEntity,
    unreadable: UnreadableRow[],
  ): ChainEnrolment | null {
    const drop = (reason: UnreadableEnrolmentReason, detail: string): null => {
      this.logger.error(
        `provider_chain_enrolments row for organization ${row.organizationId} on ` +
          `${row.chainId} ${detail} and was ignored`,
      );
      unreadable.push({ organizationId: row.organizationId, chainId: String(row.chainId), reason });
      return null;
    };

    if (!isChainId(row.chainId) || !isAccountId(row.payoutAccountId)) {
      return drop(
        UnreadableEnrolmentReason.MALFORMED_CHAIN_OR_PAYOUT,
        'has a malformed chain_id or payout_account_id',
      );
    }

    if (!STATUSES.has(row.status)) {
      return drop(UnreadableEnrolmentReason.UNKNOWN_STATUS, `has unknown status "${row.status}"`);
    }

    const raw = row.stakeAuthorityAccountId;
    let stakeAuthority: AccountId | null = null;
    if (raw !== null && raw !== undefined) {
      if (!isAccountId(raw)) {
        return drop(
          UnreadableEnrolmentReason.MALFORMED_STAKE_AUTHORITY,
          'has a malformed stake_authority_account_id',
        );
      }
      stakeAuthority = raw;
    }

    return {
      providerId: row.organizationId,
      chainId: row.chainId,
      payoutAccountId: row.payoutAccountId,
      stakeAuthorityAccountId: stakeAuthority,
      status: row.status as ChainEnrolmentStatus,
      enrolledAt: row.enrolledAt,
    };
  }
}
