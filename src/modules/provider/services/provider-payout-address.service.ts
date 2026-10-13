import { randomBytes } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderPayoutChallengeEntity } from '@database/postgres/entities/provider-payout-challenge.entity';
import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { AccountId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { PayoutProofChallenge } from '@modules/chains/ports/payout-proof.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';

import { ChainEnrolmentStatus } from '../ports/chain-enrolment.port';
import {
  PAYOUT_CHALLENGE_DEFAULT_TTL_SECONDS,
  PAYOUT_CHALLENGE_TTL_SECONDS_ENV,
} from '../constants/payout-challenge.constants';
import {
  CreatePayoutChallengeBodyDto,
  CreatePayoutChallengeResponseDto,
  ProvePayoutAddressBodyDto,
  ProvePayoutAddressResponseDto,
} from '../dto/prove-payout-address.dto';
import { renderProofMessage } from '../domain/proof-message';
import { ProviderErrors } from '../errors/provider.errors';
import { PayoutProof, PayoutProofChannel } from '../ports/provider-registration.types';

/**
 * A payout address is stored only once its wallet has signed for it,
 * console-only, and the nonce is single-use. See `provider-payout-challenge.
 * entity.ts` and `provider-chain-enrolment.entity.ts` for the two schema
 * properties this service exists to make true: there is no column for an
 * unproved address, and a challenge cannot be spent twice under concurrent
 * submission.
 *
 * ## Since multichain support the address lands on the ENROLMENT
 *
 * `providers.payout_account_id` is gone. A proof now upserts the provider's
 * enrolment on the chain the address is *on*, because one provider has one
 * answer per chain to "where do I get paid" and a single column could only
 * ever hold one of them. Re-proving on a chain already enrolled updates that
 * row; it never inserts a second one.
 *
 * ## Order of operations in `prove`, and why it is this order
 *
 * ```text
 *   1  lookup     — a challenge by this id, owned by this organization  one row
 *   2  expiry     — is it still alive?                                  no I/O
 *   3  replay     — has it already been consumed?                      (see step 5)
 *   4  signature  — did the claimed wallet really sign it?      ~50µs ed25519
 *   5  consume    — CAS UPDATE … WHERE consumed_at IS NULL, in the same
 *                   transaction as writing the provider row              2 rows
 * ```
 *
 * Step 3 is checked twice on purpose. The read in step 1 rejects the ordinary
 * case — a challenge id already used — cheaply and before any cryptography
 * runs. It cannot be the *only* check: two concurrent submissions of the same
 * valid signature would both read `consumedAt: null` and both pass. Step 5's
 * `UPDATE … WHERE consumed_at IS NULL` is what actually decides, because
 * Postgres serialises the two updates and only one can see the row still
 * open — the loser's affected-row count is `0`, not `1`, and that is read as
 * `payoutChallengeAlreadyUsed` rather than trusted as a success.
 *
 * Signature verification (step 4) is not the expensive step here the way it
 * is in `VoucherService`/`WithdrawalService` — there is no nonce store to
 * flood — but it still runs after the checks that need no I/O, for the same
 * reason: an expired or already-spent challenge should never reach ed25519.
 */
@Injectable()
export class ProviderPayoutAddressService {
  private readonly logger = new Logger(ProviderPayoutAddressService.name);

  constructor(
    private readonly providers: ProviderRepository,
    private readonly challenges: ProviderPayoutChallengeRepository,
    private readonly chains: ChainAdapterRegistry,
    private readonly config: ConfigService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    private readonly blocklist: AccountBlocklistService,
  ) {}

  /**
   * Issues a nonce for the console's "Sign a nonce to prove you control this
   * wallet" button.
   *
   * Requires a provider row to already exist — a payout address belongs to a
   * registration, and issuing a challenge for an organization with no
   * provider record would let a nonce be minted for nobody to redeem.
   */
  async issueChallenge(
    session: McpSession,
    body: CreatePayoutChallengeBodyDto,
  ): Promise<CreatePayoutChallengeResponseDto> {
    const provider = await this.providers.findOneBy({ organizationId: session.organizationId });
    if (!provider) {
      throw ProviderErrors.providerNotFound({ providerId: session.organizationId });
    }

    const chainId = body.chainId as ChainId;
    const adapter = this.chains.resolve(chainId);
    // `toAccountId` runs the identical check `isValidAddress` wraps and
    // throws `ChainErrors.invalidAddress` itself on failure. Deliberately not
    // calling `isValidAddress` and raising a second, provider-side error
    // for the same failure: `chains.errors.ts` is explicit that a `CHAIN_*`
    // code is raised only at the chain boundary, never manufactured by a
    // domain service that merely consulted a boolean.
    const account = adapter.toAccountId(chainId, body.address);

    const nonce = randomBytes(32).toString('hex');
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + this.ttlSeconds();
    const expiresAt = new Date(expiresAtSeconds * 1000);

    const challenge: PayoutProofChallenge = {
      account,
      organizationId: session.organizationId,
      nonce,
      expiresAt: expiresAtSeconds,
    };
    // What the wallet signs on eip155 — and `null` on Solana, where the
    // message bytes themselves are signed. See `renderProofMessage`.
    const typedData = adapter.payoutProofTypedData(challenge);
    const { message, messageVersion } = renderProofMessage(
      adapter.buildPayoutProofMessage(challenge),
      typedData,
    );

    const saved = await this.challenges.save(
      this.challenges.create({
        organizationId: session.organizationId,
        nonce,
        accountId: account,
        message,
        messageVersion,
        channel: PayoutProofChannel.CONSOLE,
        expiresAt,
        consumedAt: null,
        issuedTo: session.credentialId,
      }),
    );

    return {
      challengeId: saved.id,
      nonce,
      message,
      messageVersion,
      accountId: account,
      expiresAt,
      typedData,
    };
  }

  /**
   * Redeems a signed challenge and, on success, writes the proved payout
   * address onto the provider's enrolment for that chain.
   *
   * `body` carries only `challengeId` and `signature` — see
   * `ProvePayoutAddressBodyDto` for why the address and the message are never
   * accepted here. Everything verified below is read off the challenge row
   * this organization owns, never off the request.
   */
  async prove(
    session: McpSession,
    body: ProvePayoutAddressBodyDto,
  ): Promise<ProvePayoutAddressResponseDto> {
    // 1. Lookup, scoped to the caller's own organization — a challenge id
    //    belonging to another organization is indistinguishable from one that
    //    does not exist at all.
    const row = await this.challenges.findOneBy({
      organizationId: session.organizationId,
      id: body.challengeId,
    });
    if (!row) {
      throw ProviderErrors.payoutChallengeNotFound({ challengeId: body.challengeId });
    }

    // 2. Expiry.
    if (row.expiresAt.getTime() <= Date.now()) {
      throw ProviderErrors.payoutChallengeExpired({ expiresAt: row.expiresAt.toISOString() });
    }

    // 3. The cheap half of the replay check — see the class comment.
    if (row.consumedAt !== null) {
      throw ProviderErrors.payoutChallengeAlreadyUsed({ consumedAt: row.consumedAt.toISOString() });
    }

    // 4. Signature, verified against the address and the fields *stored on
    //    this row* — never rebuilt from anything the request supplied.
    //    `challenge` here is a pure function of `row`'s own columns, so it
    //    reproduces exactly the bytes `row.message` holds; the signer named
    //    is `account`, taken from `row.accountId`, so a signature from any
    //    other wallet fails here regardless of what the request claims.
    const account = row.accountId as AccountId;
    // A blocked wallet cannot become an address the platform pays.
    this.blocklist.assertNotBlocked([
      { role: BlockedRole.PAYEE, kind: BlockSubjectKind.WALLET, subject: account },
    ]);
    const adapter = this.chains.resolve(chainIdOf(account));
    const challenge: PayoutProofChallenge = {
      account,
      organizationId: row.organizationId,
      nonce: row.nonce,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    };

    if (!adapter.verifyPayoutProofSignature(challenge, body.signature, account)) {
      throw ProviderErrors.payoutSignatureInvalid({ accountId: account });
    }

    const provedAt = new Date();
    const proof: PayoutProof = {
      challengeId: row.id,
      signature: body.signature,
      messageVersion: row.messageVersion,
      provedAt: provedAt.toISOString(),
    };

    // 5. Consume the nonce and write the proof onto the enrolment, in one
    //    transaction — see the class comment for why the consume is a CAS
    //    UPDATE rather than trusting the read in step 3.
    await this.consumeAndStore(row, account, proof, provedAt);

    return { payoutAccountId: account, provedAt, proof };
  }

  private async consumeAndStore(
    row: ProviderPayoutChallengeEntity,
    account: AccountId,
    proof: PayoutProof,
    provedAt: Date,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      // Both writes below go through `manager` directly rather than through
      // `ProviderPayoutChallengeRepository`/`ProviderRepository`: those are
      // permanently bound to the global (non-transactional) connection, and
      // there is no way to rebind an `OrganizationScopedRepository` onto this
      // transaction's manager. `organization_id` is therefore pinned into
      // every predicate by hand — the same trade `SpendPolicyService.
      // writeVersion` and `LedgerHoldRepository.resolveIfOpen` make for
      // exactly this reason.
      const consumed = await manager
        .createQueryBuilder()
        .update(ProviderPayoutChallengeEntity)
        .set({ consumedAt: provedAt })
        .where('organization_id = :organizationId', { organizationId: row.organizationId })
        .andWhere('id = :id', { id: row.id })
        .andWhere('consumed_at IS NULL')
        .execute();

      if (consumed.affected !== 1) {
        // Lost the race — another submission consumed it between step 3's
        // read and this statement. `0` rows affected is the only signal that
        // matters; a stale in-memory `row.consumedAt` already said `null`.
        throw ProviderErrors.payoutChallengeAlreadyUsed({});
      }

      // The chain comes from the challenge's own account id, never from config
      // or from a request field: `issueChallenge` put the caller's address
      // through `ChainAdapter.toAccountId`, so the stored value is canonical
      // CAIP-10 and its prefix is the chain the provider actually proved.
      const chainId = chainIdOf(account);

      await manager
        .createQueryBuilder()
        .insert()
        .into(ProviderChainEnrolmentEntity)
        .values({
          organizationId: row.organizationId,
          chainId,
          payoutAccountId: account,
          payoutProof: proof,
          payoutProvedAt: provedAt,
          status: ChainEnrolmentStatus.ACTIVE,
          enrolledAt: provedAt,
        })
        // Re-proving an address on a chain already enrolled UPDATES that row.
        // It must not create a second one: `uq_provider_chain_enrolments_org_chain`
        // forbids it, and silently inserting would be the "two answers to where
        // do I get paid" the per-chain enrolment exists to remove.
        //
        // `status` and `enrolled_at` are deliberately NOT in the update list.
        // Proving a new address on a chain is not a re-enrolment: a `SUSPENDED`
        // enrolment must not be made routable again by its owner signing a
        // message, and `enrolled_at` records when the provider first declared
        // the chain — a value re-proving does not change.
        .orUpdate(
          ['payout_account_id', 'payout_proof', 'payout_proved_at'],
          ['organization_id', 'chain_id'],
        )
        .execute();
    });

    this.logger.log(`payout address proved for organization ${row.organizationId}`);
  }

  private ttlSeconds(): number {
    const raw = this.config.get<string>(PAYOUT_CHALLENGE_TTL_SECONDS_ENV);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : PAYOUT_CHALLENGE_DEFAULT_TTL_SECONDS;
  }
}
