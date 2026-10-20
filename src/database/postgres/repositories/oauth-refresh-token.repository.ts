import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OAuthRefreshTokenEntity } from '../entities/oauth-refresh-token.entity';
import { OrganizationScopedRepository } from './organization-scoped.repository';

/** Refresh tokens of OAuth grants. */
@Injectable()
export class OAuthRefreshTokenRepository extends OrganizationScopedRepository<OAuthRefreshTokenEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OAuthRefreshTokenEntity, dataSource);
  }

  /**
   * The refresh token a digest names — whichever tenant it belongs to.
   *
   * A **deliberate** cross-tenant point read, like
   * `AgentCredentialRepository.findByTokenHash`: `this.manager` bypasses
   * `OrganizationScopedRepository`'s guard because the token endpoint
   * presenting a refresh token has no `organizationId` to supply; finding out
   * which tenant it belongs to is the point of the lookup.
   * `uq_oauth_refresh_tokens_token` is platform-wide, so at most one row
   * matches. Used, revoked and expired tokens are returned like live ones:
   * reuse detection needs them.
   */
  async findByTokenHash(tokenHash: string): Promise<OAuthRefreshTokenEntity | null> {
    return this.manager
      .createQueryBuilder(OAuthRefreshTokenEntity, 'token')
      .where('token.token_hash = :tokenHash', { tokenHash })
      .getOne();
  }
}
