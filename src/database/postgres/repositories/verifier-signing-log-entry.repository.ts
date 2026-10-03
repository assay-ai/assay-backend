import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThanOrEqual } from 'typeorm';

import { SigningOutcome } from '@modules/verification/signing/domain/signing-journal';

import { VerifierSigningLogEntryEntity } from '../entities/verifier-signing-log-entry.entity';
import { AbstractRepository } from './abstract.repository';

/**
 * The signing journal.
 *
 * Two methods write, and between them they are the whole append-then-settle
 * protocol the entity describes: {@link openAttempt} records the identity of a
 * request *before* the signature exists, {@link settleAttempt} records what
 * became of it. Nothing else in the codebase may write to this table, and
 * nothing at all may delete from it.
 */
@Injectable()
export class VerifierSigningLogEntryRepository extends AbstractRepository<VerifierSigningLogEntryEntity> {
  constructor(@InjectDataSource('postgres') dataSource: DataSource) {
    super(VerifierSigningLogEntryEntity, dataSource);
  }

  /**
   * Record that a signature is about to be produced, and return the row id.
   *
   * Called before the backend is asked to sign, so that a crash mid-signature
   * leaves an `ATTEMPTED` row rather than nothing — see the entity for why the
   * difference decides whether a later correlation check is trustworthy.
   */
  async openAttempt(
    fields: Omit<Partial<VerifierSigningLogEntryEntity>, 'outcome'>,
  ): Promise<string> {
    const entry = await this.save(
      this.create({
        ...fields,
        outcome: SigningOutcome.ATTEMPTED,
      } as VerifierSigningLogEntryEntity),
    );
    return entry.id;
  }

  /**
   * Write the outcome onto a row opened by {@link openAttempt}.
   *
   * The only update this table ever takes, and it touches only the outcome
   * columns. Identity — who asked, for what, over which bytes — is fixed at
   * insert and never written again.
   */
  async settleAttempt(
    id: string,
    outcome: SigningOutcome,
    fields: { signature?: string; refusalReason?: string; observedInWindow?: number },
  ): Promise<void> {
    await this.update(id, {
      outcome,
      signature: fields.signature ?? null,
      refusalReason: fields.refusalReason ?? null,
      observedInWindow: fields.observedInWindow ?? null,
      completedAt: new Date(),
    });
  }

  /** Every line for one key since `since`, oldest first. What an investigation reads. */
  findForKeySince(keyId: string, since: Date): Promise<VerifierSigningLogEntryEntity[]> {
    return this.find({
      where: { keyId, createdAt: MoreThanOrEqual(since) },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * The row a given signed payload came from, if any.
   *
   * This is the query that turns the journal into evidence: given an
   * attestation the chain accepted, a hash with no row here means the signature
   * was produced outside this platform. Indexed on `payload_sha256` for exactly
   * that lookup.
   */
  findByPayloadHash(payloadSha256: string): Promise<VerifierSigningLogEntryEntity[]> {
    return this.find({ where: { payloadSha256 }, order: { createdAt: 'ASC' } });
  }
}
