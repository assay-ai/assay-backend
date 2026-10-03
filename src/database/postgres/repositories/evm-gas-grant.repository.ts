import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { EvmGasGrantEntity } from '../entities/evm-gas-grant.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/**
 * The gas-grant ledger.
 *
 * Two of the three methods here are **deliberately cross-organization**, which is
 * unusual enough in this codebase to state rather than to notice in review:
 *
 * - `hasGranted` asks whether an ADDRESS has been funded, ever, by anyone. The
 *   bound is one grant per address in the lifetime of the deployment, and an
 *   organization-scoped read cannot see a row another tenant wrote — so scoping
 *   this question would hand an attacker who can create organizations one grant
 *   per organization to the same address.
 * - `grantedWeiSince` is the daily cap, which is a bound on the RELAYER's float.
 *   The float is one pot shared by every tenant; summing one tenant's share of
 *   it would measure the wrong thing entirely.
 *
 * Both go through `createQueryBuilder`, whose generated SQL the scoped base
 * class still inspects — it refuses the unscoped `find`/`findBy` forms, and
 * these are the "reach for the query builder instead" case its own doc comment
 * names.
 *
 * The insert is scoped like any other write: a grant belongs to the buyer's
 * organization, and that is what makes it appear on their own audit surface.
 */
@Injectable()
export class EvmGasGrantRepository extends OrganizationScopedRepository<EvmGasGrantEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(EvmGasGrantEntity, dataSource);
  }

  /**
   * Has this address ever been granted gas, by anyone?
   *
   * A cheap pre-check, and **not the control** — see the migration. Two
   * concurrent calls both read `false` and both proceed; the unique index is
   * what settles that, and `EvmGasGrantService` maps its violation to the same
   * refusal this read produces. Removing this method would make the service
   * slower and no less correct; removing the index would make it wrong.
   */
  async hasGranted(accountId: string): Promise<boolean> {
    const count = await this.createQueryBuilder('grant')
      // `organizationId IS NOT NULL` is the idiom the rest of this codebase uses
      // to say "deliberately every tenant" to `guardOrganizationScope`, which
      // asserts the built SQL REFERENCES the column rather than that it
      // constrains it correctly. See `PaymentIntentRepository.findDueForExpiry`
      // and `AccountBalanceRepository`'s reserve reads. The column is `NOT NULL`,
      // so the predicate narrows nothing — which is exactly what is meant.
      .where('grant.organizationId IS NOT NULL')
      .andWhere('grant.accountId = :accountId', { accountId })
      .getCount();

    return count > 0;
  }

  /**
   * Claim the right to SEND to this address, or answer that somebody else holds
   * it.
   *
   * The seam this closes is between {@link hasGranted} and `sendValue`: two
   * processes both read `false`, both send, and only one row survives the
   * unique index — the ledger stays honest and the float pays twice. The index
   * cannot close it, because a grant row needs a transaction hash and the hash
   * needs the money to have left already.
   *
   * ## One statement, and why it is raw SQL
   *
   * `INSERT … ON CONFLICT (account_id) DO UPDATE … WHERE reserved_at < …`
   * decides the race inside Postgres, in one round trip, with no read-then-write
   * for two callers to interleave in. `RETURNING id` is what the caller reads:
   * a row comes back when the insert happened OR when the conditional takeover
   * fired, and nothing comes back when a live reservation is held. There is no
   * query-builder form of a conditional `DO UPDATE`, and a `SELECT … FOR UPDATE`
   * rewrite would need a transaction held open across the send.
   *
   * It goes through `this.dataSource` and not `this.query`, which
   * `OrganizationScopedRepository` refuses: the statement is deliberately
   * cross-tenant, exactly as {@link hasGranted} is, because the bound is on the
   * ADDRESS. Scoping it would hand an attacker who can create organizations one
   * in-flight attempt per organization to the same address.
   *
   * ## `leaseMs` bounds a crash, and proves nothing about a send
   *
   * Without a lease, a holder that died between claiming and recording would
   * lock that buyer out of the grant permanently. With one, a send still in
   * flight when the lease expires can be taken over — see the migration for what
   * that does and does not bound. `takenOver` is returned so the caller can say
   * so at `error` rather than silently.
   */
  async reserveGrant(reservation: {
    organizationId: string;
    chainId: string;
    accountId: string;
    leaseMs: number;
  }): Promise<{ claimed: boolean; takenOver: boolean }> {
    const rows = (await this.dataSource.query(
      `INSERT INTO "evm_gas_grant_reservations"
         ("organization_id", "chain_id", "account_id", "reserved_at")
       VALUES ($1, $2, $3, now())
       ON CONFLICT ("account_id") DO UPDATE
         SET "organization_id" = EXCLUDED."organization_id",
             "chain_id" = EXCLUDED."chain_id",
             "reserved_at" = EXCLUDED."reserved_at"
         WHERE "evm_gas_grant_reservations"."reserved_at" < now() - ($4 || ' milliseconds')::interval
       RETURNING "id", (xmax = 0) AS "inserted"`,
      [
        reservation.organizationId,
        reservation.chainId,
        reservation.accountId,
        String(reservation.leaseMs),
      ],
    )) as { id: string; inserted: boolean }[];

    // `xmax = 0` is Postgres' own answer to "was this row freshly inserted?" —
    // zero on an INSERT, and this transaction's own xid on the tuple an
    // `ON CONFLICT DO UPDATE` replaced. Deriving it from a second SELECT would
    // be a second reading of something the write itself already knows, and the
    // two could disagree.
    return { claimed: rows.length > 0, takenOver: rows.length > 0 && rows[0].inserted === false };
  }

  /**
   * Give the reservation back, so the address is not locked out for a lease.
   *
   * Called on exactly two outcomes and no others: the grant was recorded (the
   * grants index is the bound from then on), or the chain REFUSED the transfer
   * and nothing was funded. A send that THREW is deliberately not released —
   * see `EvmGasGrantService`.
   */
  async releaseGrantReservation(accountId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "evm_gas_grant_reservations" WHERE "account_id" = $1`,
      [accountId],
    );
  }

  /** Wei granted across the whole platform since `since`. The daily cap's input. */
  async grantedWeiSince(since: Date): Promise<bigint> {
    const row = await this.createQueryBuilder('grant')
      .select('COALESCE(SUM(grant.wei), 0)', 'total')
      // Same idiom, same reason — see `hasGranted`. The float is one pot shared
      // by every tenant, so summing one tenant's share would measure the wrong
      // thing.
      .where('grant.organizationId IS NOT NULL')
      .andWhere('grant.createdAt >= :since', { since })
      .getRawOne<{ total: string }>();

    return BigInt(row?.total ?? '0');
  }
}
