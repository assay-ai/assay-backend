import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';
import { ListQueryDto } from '@shared/api/dto/list-query.dto';

import { BlockSubjectKind } from '@modules/blocklist/domain/account-block';

import { ApprovalMode, OperatorRole, OverrideFamily } from '../domain/override-register';

/** Who is holding the token, as the console renders them. */
export class OperatorDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'A short handle, e.g. `dan@`' })
  subject: string;

  @ApiProperty()
  displayName: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The EVM address the operator signs in with, lower-case',
  })
  walletAddress: string | null;

  @ApiProperty({ enum: OperatorRole, isArray: true })
  roles: OperatorRole[];

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'Per-action ceiling. Null means unbounded, correct for roles that move no money.',
  })
  authorityLimit: MoneyDto | null;

  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'REMOVED'] })
  status: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
}

/** The six tiles across the top of the operator console. */
export class PlatformHealthDto {
  @ApiProperty({ description: 'Payment intents created in the last minute' })
  intentsPerMinute: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Change against the same figure an hour ago, as a share. Null on a cold start.',
  })
  intentsPerMinuteDeltaVsHour: number | null;

  @ApiProperty({ description: 'Verification records still PENDING' })
  verificationBacklog: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'p95 age of the backlog, in seconds. Null when the backlog is empty.',
  })
  verificationBacklogP95AgeSeconds: number | null;

  @ApiProperty({
    description:
      'Our own false-positive rate: overturns that count against us, over proposals resolved ' +
      'in the trailing window. The single number 07-risks names as able to kill supply overnight.',
  })
  falsePositiveRate: number;

  @ApiProperty({ description: 'The gate the rate is measured against — 2%' })
  falsePositiveGate: number;

  @ApiProperty()
  policiesInShadow: number;

  @ApiProperty()
  policiesTotal: number;

  @ApiProperty({ type: MoneyDto, description: 'Stake bonded across every provider' })
  stakeLocked: MoneyDto;

  @ApiProperty()
  providersWithStake: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Provider tools waiting for review (PENDING, first reviews and changes): the "Needs you" ' +
      'count for GET /operator/reviews. Null when it could not be read',
  })
  pendingToolReviews: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Buyer call disputes still OPEN: the "Needs you" count for GET /operator/call-disputes. ' +
      'Null when it could not be read',
  })
  openCallDisputes: number | null;

  @ApiProperty({
    type: () => [ChainStateHealthDto],
    description:
      'Per EVM chain: the indexed pause flag, blocklist and dispute-upgrade terms, and how far ' +
      'the indexer is behind. A cache of the chain — the contracts stay the enforcer.',
  })
  chainState: ChainStateHealthDto[];

  @ApiProperty({
    type: () => [SlashHoldHealthDto],
    description:
      'Providers on a slash hold: their paid bindings are not routed on that chain while ' +
      'their penalties cannot be collected promptly. Lifts by itself.',
  })
  slashHolds: SlashHoldHealthDto[];
}

/** One standing provider slash hold, in `GET /operator/health`. */
export class SlashHoldHealthDto {
  @ApiProperty({ description: "The provider's organization id" })
  providerId: string;

  @ApiProperty({ example: 'eip155:46630' })
  chainId: string;

  @ApiProperty({
    type: [String],
    enum: ['SLASH_WINDOW_FULL', 'STAKE_FULLY_RESERVED', 'BONDED_BELOW_MINIMUM'],
  })
  reasons: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  heldSince: string;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  checkedAt: string | null;
}

/** One EVM chain's row of `GET /operator/health`'s `chainState`. */
export class ChainStateHealthDto {
  @ApiProperty({ example: 'eip155:46630' })
  chainId: string;

  @ApiProperty({ description: 'AssayConfig.paused, as last indexed' })
  paused: boolean;

  @ApiPropertyOptional({ nullable: true, description: 'AssayConfig.arbiter(), lower-case' })
  arbiter: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'The live slash delay — the dispute window' })
  slashDelaySeconds: number | null;

  @ApiProperty({ description: 'Addresses blocked on chain' })
  blockedCount: number;

  @ApiPropertyOptional({ nullable: true, description: 'Last indexed block' })
  indexedBlock: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'Chain head at the last tick' })
  headBlock: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Seconds since the indexer last reached the head; null if it never has',
  })
  lagSeconds: number | null;

  @ApiProperty({ description: 'True when lagSeconds is null or above EVM_CHAIN_STATE_MAX_LAG_MS' })
  stale: boolean;

  @ApiPropertyOptional({ nullable: true })
  reconciledAt: string | null;
}

/** One row of the override log — its five columns, plus what a filter needs. */
export class OverrideLogEntryDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ enum: OverrideFamily })
  family: OverrideFamily;

  @ApiProperty({ description: 'The register row, e.g. `S-5`' })
  code: string;

  @ApiProperty({ description: 'The register row’s label, rendered as-is' })
  label: string;

  @ApiProperty({ description: 'Dotted past tense, e.g. `dispute.decided`' })
  action: string;

  @ApiProperty({ description: 'Who did it' })
  actorSubject: string;

  @ApiPropertyOptional({ nullable: true, description: 'Who approved it, on two-person rows' })
  approverSubject: string | null;

  @ApiProperty({ enum: ApprovalMode })
  approvalMode: ApprovalMode;

  @ApiProperty()
  targetType: string;

  @ApiProperty()
  targetId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The subject’s organization, when there is one',
  })
  organizationId: string | null;

  @ApiProperty()
  reasonCode: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({ type: Object, description: 'The relevant fields before — not the whole row' })
  before: Record<string, unknown>;

  @ApiProperty({ type: Object })
  after: Record<string, unknown>;

  @ApiPropertyOptional({ nullable: true })
  ticketRef: string | null;

  @ApiProperty()
  breakGlass: boolean;
}

export class ListOverrideLogQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: OverrideFamily })
  @IsOptional()
  @IsEnum(OverrideFamily)
  family?: OverrideFamily;

  @ApiPropertyOptional({ description: 'Filter to one operator’s actions' })
  @IsOptional()
  @IsUUID()
  actorOperatorId?: string;

  @ApiPropertyOptional({ description: 'e.g. `slash_proposal`' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  targetType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  targetId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;

  @ApiPropertyOptional({
    description: 'Full-text search over the reason — the field an incident review actually greps',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  q?: string;
}

/**
 * Trim before validating, so what is checked is what is recorded.
 *
 * Every operator action writes its reason code and note to the override
 * register. Without this a reason code of three spaces is "a string of at most
 * 64 characters" and a note of twenty spaces meets a twenty-character minimum.
 */
export const Trimmed = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * As {@link Trimmed}, for an optional reference: blank becomes absent, so an
 * empty ticket reference is never recorded as though one had been given.
 */
export const TrimmedOrAbsent = () =>
  Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  });

/** The single reason code of an operator action: required, and not blank. */
export const ReasonCode = () => applyDecorators(Trimmed(), IsString(), IsNotEmpty(), MaxLength(64));

/**
 * A query-string boolean. `@Type(() => Boolean)` is `Boolean(value)`, which reads
 * `'false'` as `true`; anything other than `'true'`/`'false'` is left for
 * `@IsBoolean` to refuse.
 */
export const QueryBoolean = () =>
  Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  });

/**
 * B18 (`S-15`, `S-16`, `S-17`): the operator's reason for a manual action on a
 * case stuck behind a requested cancel: a reason code, a note and an optional
 * ticket reference. What the action does is fixed by its route, and the case's
 * state is read, never taken from the body.
 */
export class ManualCaseActionBodyDto {
  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 2048)
  note: string;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/**
 * `S-5`, step two: the signature of a compensation the treasury has already
 * paid.
 *
 * `SuspendProposalBodyDto`'s fields plus the one thing that makes this route
 * different from every other override — a transaction somebody else signed.
 * It is verified against the cluster before anything is written; see
 * `SlashExecutionService.markCompensated`.
 */
export class CompensatedBodyDto {
  @ApiProperty({ description: 'The confirmed deposit_stake signature, base58' })
  @IsString()
  @Length(64, 128)
  signature: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 2048)
  note: string;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/**
 * `S-5`, step one — the unsigned `deposit_stake` an operator carries to the
 * treasury's signers.
 */
export class CompensationIntentDto {
  @ApiProperty({ description: 'Base64 wire bytes, unsigned. The treasury signs it.' })
  transaction: string;

  @ApiProperty({ description: "The provider's stake authority, base58" })
  provider: string;

  @ApiProperty({ description: 'What the chain took, in minor units' })
  amountMinor: string;

  @ApiProperty({ description: '`Config.treasury`, base58 — the funder and the fee payer' })
  depositor: string;
}

/**
 * The unsigned `cancel_slash` an operator carries to the settlement admin.
 *
 * Lean v3 made `Config.admin` the instruction's only signer, so withdrawing a
 * standing judgement is a human act with a hardware key rather than something
 * this backend completes inside a request.
 */
export class CancelIntentDto {
  @ApiProperty({ description: 'Base64 wire bytes, unsigned. The settlement admin signs it.' })
  transaction: string;

  @ApiProperty({
    description:
      'The only signer, and the fee payer: `Config.admin` (Solana; EVM without an arbiter), or ' +
      'the ARBITER on an EVM Config with one appointed (D-19). See `signerRole`.',
  })
  admin: string;

  @ApiPropertyOptional({ enum: ['ADMIN', 'ARBITER'], description: 'Who `admin` is' })
  signerRole?: 'ADMIN' | 'ARBITER';

  @ApiPropertyOptional({ description: 'EVM only: the AssayStake proxy the calldata is sent to' })
  to?: string;

  @ApiProperty({ description: "The record's 32-byte request id, lower-case hex" })
  requestId: string;

  @ApiProperty({ description: "The provider's stake authority, base58" })
  provider: string;
}

/** `V-7`: set or clear a provider’s verified label. */
export class VerifyProviderCheckDto {
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  check: string;

  @ApiProperty({ enum: ['PASS', 'FAIL', 'NOT_CHECKED'] })
  @IsIn(['PASS', 'FAIL', 'NOT_CHECKED'])
  result: 'PASS' | 'FAIL' | 'NOT_CHECKED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(512)
  note?: string;
}

export class VerifyProviderBodyDto {
  @ApiProperty()
  @IsBoolean()
  verified: boolean;

  @ApiProperty({ description: 'How it was checked, e.g. MANUAL_REVIEW' })
  @Trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  method: string;

  /**
   * A verified row with an empty check list is the shape `verification_checks`
   * exists to prevent — the entity says so and the database does not enforce
   * it, so it is enforced here.
   */
  @ApiProperty({ isArray: true, type: VerifyProviderCheckDto })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(12)
  @ValidateNested({ each: true })
  @Type(() => VerifyProviderCheckDto)
  checks: VerifyProviderCheckDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  evidenceUrl?: string;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 120 })
  @Trimmed()
  @IsString()
  @Length(120, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

// ── A-9 / A-10 · The account blocklist ─────────────────────────────────────

/**
 * `A-9` — block an organization or a wallet.
 *
 * The subject is validated and normalised by the service rather than here, so
 * the refusal for "not a uuid" and "not a CAIP-10 account" is the same
 * catalogued `OPERATOR_BLOCK_SUBJECT_INVALID` whichever kind was named.
 */
export class CreateAccountBlockBodyDto {
  @ApiProperty({ enum: BlockSubjectKind })
  @IsEnum(BlockSubjectKind)
  subjectKind: BlockSubjectKind;

  @ApiProperty({
    description:
      'An organization uuid, or a CAIP-10 account (e.g. `eip155:8453:0xabc…`). A wallet is ' +
      'blocked on every chain of its namespace.',
  })
  @Trimmed()
  @IsString()
  @IsNotEmpty()
  @MaxLength(256)
  subject: string;

  @ApiProperty({ description: 'e.g. LEAKED_KEY, FRAUD, LEGAL_HOLD' })
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20, description: 'Internal. Never shown to the blocked account.' })
  @Trimmed()
  @IsString()
  @Length(20, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/** `A-10` — lift a block. Two-person: queued for a second operator's approval. */
export class UnblockAccountBodyDto {
  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

export class ListAccountBlocksQueryDto extends ListQueryDto {
  @ApiPropertyOptional({ enum: BlockSubjectKind })
  @IsOptional()
  @IsEnum(BlockSubjectKind)
  subjectKind?: BlockSubjectKind;

  @ApiPropertyOptional({
    description:
      'An organization uuid or a CAIP-10 account; matched the way enforcement matches it, so a ' +
      'wallet finds its block on any chain of the namespace',
  })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  subject?: string;

  @ApiPropertyOptional({ description: '`true` standing blocks only, `false` lifted ones only' })
  @IsOptional()
  @QueryBoolean()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  reasonCode?: string;
}

export class AccountBlockDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: BlockSubjectKind })
  subjectKind: BlockSubjectKind;

  @ApiProperty({ description: 'Normalised: uuid lower-case, EVM address lower-case' })
  subject: string;

  @ApiProperty({ description: 'What enforcement matches on: the uuid, or `namespace:address`' })
  subjectKey: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      "An organization's public name: the provider's name, else its public handle (@handle). " +
      'Never the organization name, which can come from an email. Null for a wallet or when there is none',
  })
  subjectName: string | null;

  @ApiProperty()
  active: boolean;

  @ApiProperty()
  reasonCode: string;

  @ApiProperty()
  note: string;

  @ApiProperty({ nullable: true, type: String })
  ticketRef: string | null;

  @ApiProperty({ description: 'Operator subject' })
  blockedBy: string;

  @ApiProperty()
  blockedAt: Date;

  @ApiProperty({ nullable: true, type: String })
  unblockedBy: string | null;

  @ApiProperty({ nullable: true, type: String })
  unblockApprovedBy: string | null;

  @ApiProperty({ nullable: true, type: Date })
  unblockedAt: Date | null;

  @ApiProperty({ nullable: true, type: String })
  unblockNote: string | null;
}

/** `S-13` — the arbiter's on-chain ruling over up to 64 disputed (or pending) records. */
export class ArbiterRulingBodyDto {
  @ApiProperty({ example: 'eip155:46630' })
  @IsString()
  @Matches(/^eip155:[0-9]+$/, { message: 'chainId must be an eip155 CAIP-2 chain id' })
  chainId: string;

  @ApiProperty({
    enum: ['UPHOLD', 'CANCEL'],
    description:
      'UPHOLD → upholdSlashBatch (rules against the provider; arbiter only, DISPUTED records). ' +
      'CANCEL → cancelSlashBatch (rules for the provider; PENDING or DISPUTED records).',
  })
  @IsIn(['UPHOLD', 'CANCEL'])
  ruling: 'UPHOLD' | 'CANCEL';

  @ApiProperty({ isArray: true, type: String, minItems: 1, maxItems: 64 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(64)
  @IsString({ each: true })
  @Matches(/^0x[0-9a-fA-F]{64}$/, { each: true, message: 'each requestId must be 0x + 64 hex' })
  requestIds: string[];

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/**
 * Review R2-6: `S-13`, the arbiter's guarded `cancelSlash` of ONE superseded
 * earlier-epoch record (`GET /operator/arbiter/superseded`).
 */
export class ArbiterSupersededCancelBodyDto {
  @ApiProperty({ example: 'eip155:46630' })
  @IsString()
  @Matches(/^eip155:[0-9]+$/, { message: 'chainId must be an eip155 CAIP-2 chain id' })
  chainId: string;

  @ApiProperty({ description: 'The superseded record, 0x + 64 hex' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{64}$/, { message: 'requestId must be 0x + 64 hex' })
  requestId: string;

  @ApiProperty()
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

/** `A-11` — the arbiter's on-chain block of one address. Block only. */
export class ArbiterBlockBodyDto {
  @ApiProperty({ example: 'eip155:46630' })
  @IsString()
  @Matches(/^eip155:[0-9]+$/, { message: 'chainId must be an eip155 CAIP-2 chain id' })
  chainId: string;

  @ApiProperty({ description: 'The 0x address to block on chain' })
  @IsString()
  @Matches(/^0x[0-9a-fA-F]{40}$/, { message: 'account must be a 0x address' })
  account: string;

  @ApiProperty({ description: 'e.g. LEAKED_KEY, FRAUD' })
  @ReasonCode()
  reasonCode: string;

  @ApiProperty({ minLength: 20 })
  @Trimmed()
  @IsString()
  @Length(20, 4096)
  note: string;

  @ApiPropertyOptional()
  @TrimmedOrAbsent()
  @IsOptional()
  @IsString()
  @MaxLength(128)
  ticketRef?: string;
}

export class ArbiterTermsQueryDto {
  @ApiProperty({ example: 'eip155:46630' })
  @IsString()
  @Matches(/^eip155:[0-9]+$/, { message: 'chainId must be an eip155 CAIP-2 chain id' })
  chainId: string;
}
