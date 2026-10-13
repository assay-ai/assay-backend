import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { UNIQUE_VIOLATION_CODE } from '@database/postgres/repositories/abstract.repository';
import { ProviderChainEnrolmentEntity } from '@database/postgres/entities/provider-chain-enrolment.entity';
import { ProviderPayoutChallengeEntity } from '@database/postgres/entities/provider-payout-challenge.entity';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { ProviderPayoutChallengeRepository } from '@database/postgres/repositories/provider-payout-challenge.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { ChainAdapterRegistry } from '@modules/chains/chain-adapter.registry';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, ChainId, chainIdOf } from '@modules/chains/ports/caip.types';
import { ChainAdapter } from '@modules/chains/ports/chain-adapter.port';
import { StakeAuthorityChallenge } from '@modules/chains/ports/stake-authority.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  STAKE_AUTHORITY_CHALLENGE_DEFAULT_TTL_SECONDS,
  STAKE_AUTHORITY_CHALLENGE_TTL_SECONDS_ENV,
} from '../constants/stake-authority-challenge.constants';
import {
  CreateStakeAuthorityChallengeBodyDto,
  CreateStakeAuthorityChallengeResponseDto,
  ProveStakeAuthorityBodyDto,
  ProveStakeAuthorityResponseDto,
} from '../dto/prove-stake-authority.dto';
import { renderProofMessage } from '../domain/proof-message';
import { ProviderErrors } from '../errors/provider.errors';
import {
  ONCHAIN_STAKE_READER,
  OnChainStake,
  OnChainStakeReaderPort,
} from '../ports/onchain-stake-reader.port';
import { PayoutProof, PayoutProofChannel } from '../ports/provider-registration.types';

/**
 * The partial unique index `1759300000001-create-provider-chain-enrolments`
 * creates — `uq_providers_stake_authority` moved onto the enrolment with
 * multichain support, and was dropped from `providers` by `1759300000003`.
 */
const STAKE_AUTHORITY_UNIQUE_INDEX = 'uq_provider_chain_enrolments_stake_authority';

/** What a `pg` error carries when a unique index rejects a write. */
interface DriverError {
  readonly code?: string;
  readonly constraint?: string;
  readonly driverError?: { code?: string; constraint?: string };
}

/**
 * The link between an organization UUID and the Solana pubkey whose
 * `ProviderStake` PDA (`["stake", provider_pubkey]`) backs it, established
 * only once that pubkey has signed for it.
 *
 * ## Why this may never be self-declared
 *
 * The payout proof stops a provider redirecting *their own* earnings. This
 * one stops something with a third-party victim. If provider A could type in
 * provider B's stake pubkey:
 *
 * - A clears the router's stake gate on B's collateral, and takes paid traffic
 *   that nothing of A's is actually backing;
 * - when A defects, the slash attestation this platform signs names B's PDA,
 *   so **B loses money because of A**.
 *
 * The party who lied is not the party who pays. That is why the address on the
 * request body does not exist: `prove` reads the account off the challenge row
 * the platform itself wrote at issue time.
 *
 * ## Order of operations in `prove`, and why it is this order
 *
 * ```text
 *   1  lookup     — a challenge by this id, owned by this organization    one row
 *   2  kind       — was it issued for *this* proof? (message_version)      no I/O
 *   3  expiry     — is it still alive?                                     no I/O
 *   4  replay     — has it already been consumed?                      (see step 7)
 *   5  signature  — did the claimed wallet really sign it?        ~50µs ed25519
 *   6  exited     — is the account the CURRENT authority names empty?  one RPC
 *   7  consume    — CAS UPDATE … WHERE consumed_at IS NULL, in the same
 *                   transaction as writing the provider row               2 rows
 * ```
 *
 * Step 4 is checked twice on purpose, exactly as in
 * `ProviderPayoutAddressService`. The read in step 1 rejects the ordinary case
 * — a challenge id already used — cheaply and before any cryptography runs. It
 * cannot be the *only* check: two concurrent submissions of the same valid
 * signature would both read `consumedAt: null` and both pass. Step 7's
 * `UPDATE … WHERE consumed_at IS NULL` is what actually decides, because
 * Postgres serialises the two updates and only one can see the row still open
 * — the loser's affected-row count is `0`, not `1`, and that is read as
 * `stakeChallengeAlreadyUsed` rather than trusted as a success.
 *
 * ## Step 6 — a funded stake account cannot be swapped out
 *
 * Re-proving used to overwrite the `stake_authority` / `stake_proof` /
 * `stake_proved_at` trio silently, and that is not merely a missing audit
 * trail. The backend derives the stake PDA from the enrolment's
 * `stake_authority_account_id` (formerly `providers.stake_authority`)
 * **at the moment it needs it**, and one of those moments is building a slash
 * attestation. So this sequence worked:
 *
 * ```text
 *   provider defects        →  a verdict is forming
 *   rotate stake_authority  →  to a fresh pubkey whose PDA is empty
 *   slash attestation       →  now points at the empty PDA
 *   real collateral         →  still in the OLD account, withdrawable later
 * ```
 *
 * The whole stake gate rests on "a provider who defects loses more than they
 * gained". Free rotation makes that premise false, so the rotation is refused
 * while the **current** account still holds capital. Exiting an account is
 * already gated by the 14-day unbonding period, which outlasts the dispute
 * window — so "fully exit the old one first" is a real barrier rather than a
 * speed bump, and it needs no new timer of its own.
 *
 * Two balances are read, and **either** being non-zero refuses:
 *
 * - `bonded` — the obvious one;
 * - `unbonding` — still fully slashable for the entire period, which is what
 *   the period is *for*. An account mid-unbonding is exactly the one a
 *   defector wants to walk away from.
 *
 * There used to be a third, `exposed`, asserted on chain by the platform. Lean
 * v3 removed it: the program bounds a withdrawal with the unbonding clock and
 * `pending_slash` instead, so an account whose two balances are zero is an
 * account with nothing left to walk away from.
 *
 * ### Why after the signature, and why before the consume
 *
 * **Before the consume** is not negotiable: a refusal is not a spend. The
 * provider's remedy is to exit the old account and retry, and they must be able
 * to retry with the same challenge while it is still alive. Burning the nonce
 * on a refusal would cost a round trip to the console for no security gain.
 *
 * **After the signature** is the deliberate half. This step is the only I/O in
 * `prove` that leaves the process — a `getMultipleAccounts`, plus the settlement
 * `Config` read behind it — and it is ordered behind the cheapest possible
 * rejection of a request that was never going to succeed. Confidentiality does
 * not decide this: a stake account's balance is public on chain, and the caller
 * is an authenticated provider asking about their own account, so the ordering
 * leaks nothing either way. What decides it is (a) not letting an unsigned
 * submission generate RPC traffic on this endpoint, and (b) which failure is
 * the actionable one — a provider whose signature is wrong *and* whose old
 * account is funded should be told about the signature first, because emptying
 * the account would not have made the request succeed.
 *
 * ### It fails closed
 *
 * `OnChainStakeReaderPort` throws when the chain cannot be read, and the
 * refusal stands. "We could not read the old PDA" must never resolve to "it was
 * probably empty" — that is the escape hatch reopening itself, and an attacker
 * able to degrade one RPC endpoint would have re-earned free rotation. Note the
 * asymmetry with `OnChainProviderStakeSource`, which *swallows* the same
 * failure: there the caller is the router and an exception would be an outage,
 * here the caller is one provider changing one key and the safe answer is to
 * make them try again.
 *
 * What the throw is not allowed to do is reach the caller as a bare `500`. An
 * RPC failure inside the reader is an ordinary `Error`, which
 * `AllExceptionsFilter` renders as `INTERNAL_SERVER_ERROR` / "Internal server
 * error" outside development — a refusal with no cause and no remedy attached,
 * which is fail-closed nobody can act on. So it is translated into
 * `stakeAuthorityCheckUnavailable`: the same refusal, as a `503` that names the
 * cause and says to retry. That also covers the one shape of this failure that
 * is not transient — `SETTLEMENT_PROGRAM_ID` unset, which is a legitimate
 * deployment and which otherwise leaves a provider who has proved once unable
 * to ever prove again, with a `500` and nothing to go on.
 *
 * An account **absent** from the reader's answer is not a failure — it means
 * the chain answered and there is no stake account at those seeds. Nothing to
 * lose, so the rotation proceeds.
 *
 * The check is skipped entirely when there is no current authority, which is
 * the common case: a provider proving for the first time has no old account,
 * so there is nothing to check and no RPC to pay for. A gate that made
 * first-time onboarding depend on a reachable chain would have converted an RPC
 * outage into "nobody can register".
 *
 * Re-proving the **same** authority is not carved out. On a funded account it
 * is refused along with everything else, because the rule is about the account
 * and not about which key is being written, and a same-key re-prove achieves
 * nothing the trio does not already record. Widening the gate for it would mean
 * one more branch guarding one more equality, on the single code path whose
 * whole job is to be hard to get past.
 *
 * ## Why this reuses `provider_payout_challenges`, and what step 2 is for
 *
 * The row is the same artefact: a nonce, the exact bytes to sign, the account
 * they name, an expiry and a single-use flag. What differs is the *message*,
 * and `message_version` is the column that records which one — it is already
 * the discriminator, so a second table would duplicate the schema in order to
 * store a fact one existing column states.
 *
 * Step 2 is the one step `ProviderPayoutAddressService`'s five do not have,
 * and it is second because sharing the table means a payout challenge can be
 * *presented* here. Step 5 would catch it anyway — the bytes this service
 * builds lead with a different version tag, so a payout signature cannot
 * verify against them — but that is the signature check doing the
 * discriminator's job, and it only holds for a submission that carries a
 * signature at all. Checking the column makes a wrong-kind challenge
 * indistinguishable from one that does not exist, which is what it is.
 *
 * The expected tag is read back off the message this run's own adapter builds,
 * never imported as a constant: `STAKE_AUTHORITY_MESSAGE_VERSION` lives in
 * `chains/solana/`, and a chain-specific string in a domain service is exactly
 * what the `chains/` boundary exists to keep out. Reading the leading line of a
 * rendered message is generic string handling — the same trade
 * `ProviderPayoutAddressService.issueChallenge` makes one level up.
 *
 * `message` and `account_id` are read **off the row**, never off the request.
 * A verifier that rebuilds the signed bytes from what the client sent verifies
 * whatever the client says the bytes were — see
 * `provider-payout-challenge.entity.ts`, which is that argument's database
 * half, and `SolanaChainAdapter`, which is its chain half.
 *
 * ## Where the trio is written
 *
 * Onto `provider_chain_enrolments`, for the chain the proved account's own
 * CAIP-10 prefix names — one row per chain, so a provider can stake on Solana
 * and on `eip155:4663` and be slashed independently on each. **The enrolment
 * must already exist**: proving a stake authority for a chain with no enrolment
 * is `PROVIDER_CHAIN_NOT_ENROLLED`, decision (a) enforced at the write path.
 * You cannot stake on a chain you have not declared a payout address for,
 * because there would be nowhere to pay you.
 *
 * ## Normalisation, and what the unique index actually guarantees
 *
 * `uq_provider_chain_enrolments_stake_authority` is a unique index over a
 * `varchar`. On its
 * own it blocks byte-identical duplicates and nothing more, so two spellings
 * of one account — a bare base58 pubkey without the CAIP prefix, say — would
 * both insert and both clear the stake gate on one pool of capital. Two things
 * close that here: every stored value passes through
 * `ChainAdapter.toAccountId`, which validates and canonicalises, at the single
 * point (`issueChallenge`) where a caller-supplied address enters; and
 * `chk_provider_chain_enrolments_stake_caip10` refuses anything that is not
 * CAIP-10-shaped, and `chk_provider_chain_enrolments_stake_on_chain` refuses an
 * account that is not on the row's own chain — so the guarantee does not depend
 * on every future writer remembering the first rule.
 */
@Injectable()
export class ProviderStakeAuthorityService {
  private readonly logger = new Logger(ProviderStakeAuthorityService.name);

  constructor(
    private readonly providers: ProviderRepository,
    private readonly enrolments: ProviderChainEnrolmentRepository,
    private readonly challenges: ProviderPayoutChallengeRepository,
    private readonly chains: ChainAdapterRegistry,
    private readonly config: ConfigService,
    @InjectDataSource('postgres') private readonly dataSource: DataSource,
    @Inject(ONCHAIN_STAKE_READER) private readonly stakeReader: OnChainStakeReaderPort,
    private readonly blocklist: AccountBlocklistService,
  ) {}

  /**
   * Issues a nonce for the console's "Sign a nonce to prove you control this
   * stake wallet" button.
   *
   * Requires a provider row to already exist — a stake authority belongs to a
   * registration, and issuing a nonce for an organization with no provider
   * record would mint a challenge nobody can redeem.
   */
  async issueChallenge(
    session: McpSession,
    body: CreateStakeAuthorityChallengeBodyDto,
  ): Promise<CreateStakeAuthorityChallengeResponseDto> {
    const provider = await this.providers.findOneBy({ organizationId: session.organizationId });
    if (!provider) {
      throw ProviderErrors.providerNotFound({ providerId: session.organizationId });
    }

    const chainId = body.chainId as ChainId;
    const adapter = this.chains.resolve(chainId);
    // The single normalisation point — see the class comment. `toAccountId`
    // validates and canonicalises in one call and raises
    // `ChainErrors.invalidAddress` itself, so no `CHAIN_*` code is
    // manufactured here from a boolean; `chains.errors.ts` is explicit that
    // those are raised only at the chain boundary.
    const account = adapter.toAccountId(chainId, body.address);

    const nonce = randomBytes(32).toString('hex');
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + this.ttlSeconds();
    const expiresAt = new Date(expiresAtSeconds * 1000);

    const challenge: StakeAuthorityChallenge = {
      account,
      organizationId: session.organizationId,
      nonce,
      expiresAt: expiresAtSeconds,
    };
    // What the wallet signs on eip155 — `null` on Solana. See `renderProofMessage`.
    const typedData = adapter.stakeAuthorityTypedData(challenge);
    const { message, messageVersion } = renderProofMessage(
      adapter.buildStakeAuthorityMessage(challenge),
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
   * Redeems a signed challenge and, on success, writes the proved stake
   * authority onto the provider row.
   *
   * `body` carries only `challengeId` and `signature` — see
   * `ProveStakeAuthorityBodyDto` for why there is no field naming the account.
   * Everything verified below is read off the challenge row this organization
   * owns, never off the request.
   */
  async prove(
    session: McpSession,
    body: ProveStakeAuthorityBodyDto,
  ): Promise<ProveStakeAuthorityResponseDto> {
    // 1. Lookup, scoped to the caller's own organization — a challenge id
    //    belonging to another organization is indistinguishable from one that
    //    does not exist at all.
    const row = await this.challenges.findOneBy({
      organizationId: session.organizationId,
      id: body.challengeId,
    });
    if (!row) {
      throw ProviderErrors.stakeChallengeNotFound({ challengeId: body.challengeId });
    }

    // Everything below is a pure function of `row`'s own columns: the account
    // named is `row.accountId`, the nonce and expiry are the row's, and the
    // bytes reproduced are exactly the ones `row.message` holds. Nothing here
    // is rebuilt from the request, which carries only an id and a signature.
    const account = row.accountId as AccountId;
    // A blocked wallet cannot become a stake authority.
    this.blocklist.assertNotBlocked([
      { role: BlockedRole.STAKE_AUTHORITY, kind: BlockSubjectKind.WALLET, subject: account },
    ]);
    const adapter = this.chains.resolve(chainIdOf(account));
    const challenge: StakeAuthorityChallenge = {
      account,
      organizationId: row.organizationId,
      nonce: row.nonce,
      expiresAt: Math.floor(row.expiresAt.getTime() / 1000),
    };

    // 2. Kind. A payout challenge shares this table; it is not redeemable
    //    here, and saying "not found" is the honest answer for a row this
    //    endpoint has no business reading. See the class comment for why this
    //    is not left to the signature check in step 5.
    if (row.messageVersion !== this.stakeMessageVersion(adapter, challenge)) {
      throw ProviderErrors.stakeChallengeNotFound({ challengeId: body.challengeId });
    }

    // 3. Expiry.
    if (row.expiresAt.getTime() <= Date.now()) {
      throw ProviderErrors.stakeChallengeExpired({ expiresAt: row.expiresAt.toISOString() });
    }

    // 4. The cheap half of the replay check — see the class comment.
    if (row.consumedAt !== null) {
      throw ProviderErrors.stakeChallengeAlreadyUsed({ consumedAt: row.consumedAt.toISOString() });
    }

    // 5. Signature. The signer named is `row.accountId`, so a signature from
    //    any other wallet fails here no matter what the request claims, and a
    //    payout proof over these same four values fails too, because
    //    `buildStakeAuthorityMessage` leads with a different version tag.
    if (!adapter.verifyStakeAuthoritySignature(challenge, body.signature, account)) {
      throw ProviderErrors.stakeSignatureInvalid({ accountId: account });
    }

    // 6. The stake authority is a column on the ENROLMENT,
    //    so a chain with no enrolment has nowhere to record it — and the reason
    //    it is refused rather than created is the decision, not the schema:
    //    an enrolment is where the provider says how they get paid, and
    //    collateral behind calls whose earnings have nowhere to go protects
    //    nobody. Before the chain read, because it costs one indexed row and
    //    an RPC is worth avoiding on a request that cannot succeed.
    const chainId = chainIdOf(account);
    const enrolment = await this.enrolments.findOneBy({
      organizationId: row.organizationId,
      chainId,
    });
    if (!enrolment) {
      throw ProviderErrors.chainNotEnrolled({ chainId, providerId: row.organizationId });
    }

    // 7. A proved authority may only be replaced once the account it
    //    currently names is empty — otherwise a defecting provider re-points
    //    the slash attestation this platform signs at a fresh, empty PDA and
    //    keeps the collateral. Deliberately after step 5 and before step 8; the
    //    long argument for both is in the class comment.
    await this.assertCurrentAccountFullyExited(
      row.organizationId,
      (enrolment.stakeAuthorityAccountId as AccountId | null) ?? null,
      account,
    );

    const provedAt = new Date();
    const proof: PayoutProof = {
      challengeId: row.id,
      signature: body.signature,
      messageVersion: row.messageVersion,
      provedAt: provedAt.toISOString(),
    };

    // 8. Consume the nonce and write the proof onto the ENROLMENT for this
    //    chain, in one transaction — see the class comment for why the consume
    //    is a CAS UPDATE rather than trusting the read in step 4.
    await this.consumeAndStore(row, chainId, account, proof, provedAt);

    return { stakeAuthority: account, provedAt, proof };
  }

  /**
   * Refuses `incoming` while the provider's **current** stake authority still
   * names an account holding slashable collateral.
   *
   * The provider row is re-read here rather than carried down from
   * `issueChallenge`: the challenge row records the account being *proved*, and
   * this needs the one already *proved*, which only `providers` holds and which
   * may have changed since the nonce was issued. The read is scoped to the
   * caller's own organization like every other read on this path.
   *
   * Returns silently in the two cases where there is nothing to protect — no
   * current authority at all, and a current authority whose account does not
   * exist on chain — and throws in every other case where a balance is
   * non-zero. A chain failure is caught only to be re-raised as a typed `503`;
   * it is never absorbed into "the account was probably empty". See the class
   * comment on failing closed.
   */
  private async assertCurrentAccountFullyExited(
    organizationId: string,
    current: AccountId | null,
    incoming: AccountId,
  ): Promise<void> {
    if (!current) {
      // First proof. No old account, so no chain read at all — this is the
      // common case and it must not depend on a reachable RPC.
      return;
    }

    // Fails closed on an unreachable chain, and that is the intended behaviour
    // — but as a `503` that names the cause, not as the bare `500` an ordinary
    // `Error` from the RPC would otherwise become. The refusal is unchanged;
    // only what the provider is told about it is. See the class comment.
    let readings: ReadonlyMap<AccountId, OnChainStake>;
    try {
      readings = await this.stakeReader.bondedStakeOf([current]);
    } catch (cause) {
      this.logger.error(
        `stake-authority rotation refused for organization ${organizationId}: ` +
          `the current account (${current}) could not be read`,
        cause instanceof Error ? cause.stack : String(cause),
      );
      throw ProviderErrors.stakeAuthorityCheckUnavailable({
        currentAuthority: current,
        incomingAuthority: incoming,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const reading = readings.get(current);
    if (!reading) {
      // The chain answered and there is no stake account at those seeds. The
      // port is explicit that absent is not zero, and here both mean the same
      // thing anyway: there is nothing left to walk away from.
      return;
    }

    if (this.isFullyExited(reading)) {
      return;
    }

    // `bonded + unbonding` is the capital still in the account.
    const remaining = MoneyUtil.add(reading.bonded, reading.unbonding);

    // The symbol, not the CAIP-19, and on the leading amount only. All three
    // amounts are the same asset by construction — they come out of one account
    // read — so naming it once is enough, and `token:EPjFWdd5…` in a sentence a
    // confused provider is reading is noise where `USDC` is information. The
    // full asset id stays in the context, for logs, where a devnet mint and a
    // mainnet mint being two different assets does matter.
    const withSymbol = { symbol: getAssetMetadata(reading.bonded.asset).symbol };

    throw ProviderErrors.stakeAuthorityStillFunded({
      currentAuthority: current,
      incomingAuthority: incoming,
      remaining: MoneyUtil.format(remaining, withSymbol),
      bonded: MoneyUtil.format(reading.bonded),
      unbonding: MoneyUtil.format(reading.unbonding),
      asset: reading.bonded.asset,
      observedAt: reading.observedAt.toISOString(),
    });
  }

  /** True only when both balances on the account are zero. */
  private isFullyExited(reading: OnChainStake): boolean {
    return MoneyUtil.isZero(reading.bonded) && MoneyUtil.isZero(reading.unbonding);
  }

  private async consumeAndStore(
    row: ProviderPayoutChallengeEntity,
    chainId: ChainId,
    account: AccountId,
    proof: PayoutProof,
    provedAt: Date,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        // Both writes go through `manager` directly rather than through the
        // repositories: those are permanently bound to the global
        // (non-transactional) connection, and an `OrganizationScopedRepository`
        // cannot be rebound onto this transaction's manager. `organization_id`
        // is therefore pinned into every predicate by hand — the same trade
        // `ProviderPayoutAddressService.consumeAndStore` and
        // `LedgerHoldRepository.resolveIfOpen` make for exactly this reason.
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
          throw ProviderErrors.stakeChallengeAlreadyUsed({});
        }

        // The trio moves together, in one statement, because
        // `chk_provider_chain_enrolments_stake_proved_together` refuses any
        // other combination — there is no column that can hold a stake
        // authority which has not been proved.
        //
        // An UPDATE and deliberately **not** the `orUpdate` upsert
        // `ProviderPayoutAddressService` uses one file over. An upsert would
        // have to invent `payout_account_id` / `payout_proof` /
        // `payout_proved_at` for the insert branch — all three are `NOT NULL`,
        // and there is nothing honest to put in them — so the insert branch is
        // not a fallback, it is a fabricated payout address. `affected === 0`
        // means the enrolment vanished between step 6 and here, which nothing
        // in this codebase does (enrolments are never deleted), and it is
        // reported as the same refusal step 6 gives rather than trusted.
        const updated = await manager
          .createQueryBuilder()
          .update(ProviderChainEnrolmentEntity)
          .set({
            stakeAuthorityAccountId: account,
            stakeProof: proof,
            stakeProvedAt: provedAt,
          })
          .where('organization_id = :organizationId', { organizationId: row.organizationId })
          .andWhere('chain_id = :chainId', { chainId })
          .execute();

        if (updated.affected !== 1) {
          throw ProviderErrors.chainNotEnrolled({ chainId, providerId: row.organizationId });
        }
      });
    } catch (error) {
      // `uq_provider_chain_enrolments_stake_authority` is the constraint that
      // stops one pool of collateral backing two providers, and it is reachable by two
      // organizations proving the same wallet concurrently — neither read
      // would see the other. Postgres decides; this only translates its answer
      // into the domain's, so the loser gets a 409 naming the account instead
      // of a 500 naming an index. Any *other* unique violation is re-thrown
      // untouched: reporting an unrelated constraint as "already claimed"
      // would send whoever reads the log to the wrong column.
      if (this.isStakeAuthorityConflict(error)) {
        throw ProviderErrors.stakeAuthorityAlreadyClaimed({ accountId: account });
      }
      throw error;
    }

    this.logger.log(`stake authority proved for organization ${row.organizationId}`);
  }

  /**
   * The version tag a stake-authority message for `challenge` leads with, as
   * this chain's adapter renders it.
   *
   * Asked of the adapter rather than imported, so the domain never holds a
   * chain's string format — see the class comment. It is cheap enough to do on
   * every `prove`: `buildStakeAuthorityMessage` is a five-element string join.
   */
  private stakeMessageVersion(adapter: ChainAdapter, challenge: StakeAuthorityChallenge): string {
    return renderProofMessage(
      adapter.buildStakeAuthorityMessage(challenge),
      adapter.stakeAuthorityTypedData(challenge),
    ).messageVersion;
  }

  private isStakeAuthorityConflict(error: unknown): boolean {
    const candidate = error as DriverError;
    const code = candidate?.code ?? candidate?.driverError?.code;
    if (code !== UNIQUE_VIOLATION_CODE) {
      return false;
    }

    const constraint = candidate?.constraint ?? candidate?.driverError?.constraint;
    // Some driver/TypeORM combinations surface the index name only in the
    // message, so the message is the fallback rather than the primary check —
    // a name match is what keeps this from claiming every 23505.
    return constraint === STAKE_AUTHORITY_UNIQUE_INDEX
      ? true
      : constraint === undefined &&
          typeof (error as Error)?.message === 'string' &&
          (error as Error).message.includes(STAKE_AUTHORITY_UNIQUE_INDEX);
  }

  private ttlSeconds(): number {
    const raw = this.config.get<string>(STAKE_AUTHORITY_CHALLENGE_TTL_SECONDS_ENV);
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? parsed
      : STAKE_AUTHORITY_CHALLENGE_DEFAULT_TTL_SECONDS;
  }
}
