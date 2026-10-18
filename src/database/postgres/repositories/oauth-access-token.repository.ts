import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OAuthAccessTokenEntity } from '../entities/oauth-access-token.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Access tokens of OAuth grants. */
@Injectable()
export class OAuthAccessTokenRepository extends OrganizationScopedRepository<OAuthAccessTokenEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OAuthAccessTokenEntity, dataSource);
  }

  /**
   * The access token a bearer digest names — whichever tenant it belongs to.
   *
   * A **deliberate** cross-tenant point read, like
   * `AgentCredentialRepository.findByTokenHash`: `this.manager` bypasses
   * `OrganizationScopedRepository`'s guard because a session source
   * authenticating a bearer token has no `organizationId` to supply.
   * `uq_oauth_access_tokens_token` is platform-wide, so at most one row
   * matches. Revoked and expired tokens are returned like live ones: what
   * they mean is the session source's decision.
   */
  async findByTokenHash(tokenHash: string): Promise<OAuthAccessTokenEntity | null> {
    return this.manager
      .createQueryBuilder(OAuthAccessTokenEntity, 'token')
      .where('token.token_hash = :tokenHash', { tokenHash })
      .getOne();
  }
}
