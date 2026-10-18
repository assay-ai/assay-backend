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
}
