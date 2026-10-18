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
   * (a re-fetched CIMD document, the built-in row at boot). `id`, `created_at`
   * and `last_used_at` are kept, so credentials issued to it stay attached.
   */
  async upsertByClientId(values: OAuthClientUpsert): Promise<OAuthClientEntity> {
    await this.createQueryBuilder()
      .insert()
      .into(OAuthClientEntity)
      .values(values)
      .orUpdate(
        [
          'kind',
          'client_name',
          'client_uri',
          'redirect_uris',
          'metadata',
          'fetched_at',
          'cache_until',
          'updated_at',
        ],
        ['client_id'],
      )
      .execute();
    const row = await this.findByClientId(values.clientId);
    if (!row) throw new Error('oauth_clients upsert did not leave a row');
    return row;
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
