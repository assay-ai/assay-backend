import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ChainId } from '@modules/chains/ports/caip.types';
import { SigningKeyState } from '@modules/verification/signing/domain/key-lifecycle';

import { VerifierSigningKeyEntity } from '../entities/verifier-signing-key.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The verifier key directory.
 *
 * `AbstractRepository`, not `OrganizationScopedRepository` — the verifier
 * identity belongs to the platform, not to a tenant. See the entity.
 */
@Injectable()
export class VerifierSigningKeyRepository extends AbstractRepository<VerifierSigningKeyEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(VerifierSigningKeyEntity, dataSource);
  }

  findByKeyId(keyId: string): Promise<VerifierSigningKeyEntity | null> {
    return this.findOne({ where: { keyId } });
  }

  /**
   * The one key that signs **on this chain**, or `null` during a rotation gap.
   *
   * "The one" is a database guarantee, not a convention: the partial unique
   * index `(chain_id) WHERE state = 'ACTIVE'` means a second activation on the
   * same chain fails rather than producing a directory in which this query's
   * answer depends on row order.
   *
   * The `chainId` argument is not optional and deliberately so. An overload
   * that returned "the active key" with no chain would be answerable only while
   * exactly one chain is live, and it would keep compiling — returning an
   * arbitrary one of two rows — on the day a second is enabled.
   */
  findActive(chainId: ChainId): Promise<VerifierSigningKeyEntity | null> {
    return this.findOne({ where: { state: SigningKeyState.ACTIVE, chainId } });
  }

  /** Newest first — what the rotation tooling and the ops read print. */
  findAllOrdered(): Promise<VerifierSigningKeyEntity[]> {
    return this.find({ order: { createdAt: 'DESC' } });
  }

  /**
   * Move a key between states, refusing if it is no longer in `from`.
   *
   * A compare-and-swap rather than a read-then-write, and the same reasoning as
   * `policyTransitionLost` in the policy lifecycle: two operators rotating at
   * once, or an operator racing the incident-response revoke, must not both
   * believe they won. Returns whether this caller was the one that moved it.
   */
  async transition(
    keyId: string,
    from: SigningKeyState,
    to: SigningKeyState,
    fields: Partial<VerifierSigningKeyEntity>,
  ): Promise<boolean> {
    const result = await this.createQueryBuilder()
      .update(VerifierSigningKeyEntity)
      .set({ ...fields, state: to })
      .where('key_id = :keyId AND state = :from', { keyId, from })
      .execute();
    return (result.affected ?? 0) > 0;
  }
}
