import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { OAuthAuthorizationCodeEntity } from '../entities/oauth-authorization-code.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * Authorization codes. Platform-wide: the token endpoint resolves a code by
 * its hash before it knows which tenant approved it.
 */
@Injectable()
export class OAuthAuthorizationCodeRepository extends AbstractRepository<OAuthAuthorizationCodeEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(OAuthAuthorizationCodeEntity, dataSource);
  }

  /**
   * The code whose digest is `codeHash`, used or not and expired or not: the
   * caller decides what a used or expired code means.
   */
  async findByCodeHash(codeHash: string): Promise<OAuthAuthorizationCodeEntity | null> {
    return this.findOne({ where: { codeHash } });
  }
}
