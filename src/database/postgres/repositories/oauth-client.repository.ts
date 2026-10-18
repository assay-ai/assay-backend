import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OAuthClientEntity } from '../entities/oauth-client.entity';
import { AbstractRepository } from './abstract.repository';

/** OAuth clients of the MCP authorization server. Platform-wide, not tenant data. */
@Injectable()
export class OAuthClientRepository extends AbstractRepository<OAuthClientEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OAuthClientEntity, dataSource);
  }

  /** The client registered under `clientId` (a CIMD URL, `dcr_…`, or the built-in URL). */
  async findByClientId(clientId: string): Promise<OAuthClientEntity | null> {
    return this.findOne({ where: { clientId } });
  }

  /** Insert a new client; a `client_id` already present fails on the unique index. */
  async insertClient(values: OAuthClientUpsert): Promise<OAuthClientEntity> {
    return this.save(this.create(values));
  }

  /**
   * Insert the client under `values.clientId`, or overwrite its stored fields
   * (a re-fetched CIMD document, the built-in row at boot). `id`, `kind`,
   * `created_at` and `last_used_at` are kept, so credentials issued to it stay
   * attached. A row of another kind is never touched: `null` is returned, so a
   * built-in or DCR row can never become a CIMD client (or the reverse).
   */
  async upsertByClientId(values: OAuthClientUpsert): Promise<OAuthClientEntity | null> {
    const rows: Array<{ id: string }> = await this.query(
      `INSERT INTO "oauth_clients"
         ("client_id", "kind", "client_name", "client_uri", "redirect_uris", "metadata",
          "fetched_at", "cache_until")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("client_id") DO UPDATE SET
         "client_name"   = EXCLUDED."client_name",
         "client_uri"    = EXCLUDED."client_uri",
         "redirect_uris" = EXCLUDED."redirect_uris",
         "metadata"      = EXCLUDED."metadata",
         "fetched_at"    = EXCLUDED."fetched_at",
         "cache_until"   = EXCLUDED."cache_until",
         "updated_at"    = now(),
         "version"       = "oauth_clients"."version" + 1
       WHERE "oauth_clients"."kind" = EXCLUDED."kind"
       RETURNING "id"`,
      [
        values.clientId,
        values.kind,
        values.clientName,
        values.clientUri,
        values.redirectUris,
        JSON.stringify(values.metadata),
        values.fetchedAt,
        values.cacheUntil,
      ],
    );
    if (rows.length === 0) return null;
    return this.findOne({ where: { id: rows[0].id } });
  }
}

/** The fields an upsert writes; the rest keep their defaults or stored values. */
export type OAuthClientUpsert = Pick<
  OAuthClientEntity,
  | 'clientId'
  | 'kind'
  | 'clientName'
  | 'clientUri'
  | 'redirectUris'
  | 'metadata'
  | 'fetchedAt'
  | 'cacheUntil'
>;
