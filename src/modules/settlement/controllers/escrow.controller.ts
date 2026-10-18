import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS,
  toUnsignedChainTransactionDto,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, toAccountId } from '@modules/chains/ports/caip.types';
import { EscrowLimits } from '@modules/chains/ports/escrow.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AuditLogWriter, auditActorOf } from '@shared/audit';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';
import { MoneyUtil } from '@shared/utils/money.util';

import {
  CreateEscrowIntentResponseDto,
  RequestWithdrawBodyDto,
  SetEscrowLimitsBodyDto,
  WithdrawBodyDto,
  WithdrawGasGrantDto,
} from '../dto/create-escrow-intent.dto';
import {
  GetEscrowResponseDto,
  GetEscrowUnsettledResponseDto,
  toUnsettledDto,
} from '../dto/get-escrow.dto';
import {
  RelayedEscrowIntentResponseDto,
  SubmitRequestWithdrawBodyDto,
  SubmitSetLimitsBodyDto,
} from '../dto/submit-relayed-escrow-intent.dto';
import { EscrowIntentKind } from '../ports/escrow-intent-builder.port';
import { WithdrawGasGrant } from '../ports/withdraw-gas-grant.port';
import { EscrowAccountService, EscrowState } from '../services/escrow-account.service';
import {
  EscrowIntentResult,
  RelayedEscrowIntentResult,
  WithdrawalService,
} from '../services/withdrawal.service';

/**
 * `GET /escrow`, `POST /escrow/{limits,withdrawals/request,withdrawals,close}-intent`
 * — the settlement domain's first HTTP surface.
 *
 * All five routes are session-authenticated and take the account from
 * `@CurrentSession()`; none takes it from the request. A request that could
 * name the account is a request one buyer could point at another buyer's
 * escrow. **The consumer is the console** — a browser, behind Privy — not the
 * agent that calls `GET /escrow/next-seq` (a different controller, in
 * `payment/`, authenticated the same way `POST /tool-calls` is).
 *
 * The four `POST`s return an unsigned transaction and write nothing —
 * `POST` rather than `GET` for the same two reasons `ProviderStakeIntentController`
 * gives: the amount is a body, and a `GET` is what caches, proxies and browser
 * histories are entitled to keep, and these responses carry a buyer's
 * balances.
 */
/**
 * What the three `*-intent` routes answer when the chain cannot be read.
 *
 * They cannot do what `GET /escrow` does: each one builds a transaction that
 * names `Config.stake_mint`, so an unreadable `Config` leaves nothing to build
 * against, and a guessed mint would aim `withdraw` at the wrong token account.
 * Refusing is correct — refusing with `SETTLEMENT_ESCROW_CHAIN_UNREADABLE`
 * rather than a decoder's 500 is what makes it actionable.
 */
const ESCROW_CHAIN_UNREADABLE_DESCRIPTION =
  'SETTLEMENT_ESCROW_CHAIN_UNREADABLE — the chain could not be read, so the escrow mint that ' +
  'every one of these transactions names is unknown. Nothing is built and nothing is guessed.';

/**
 * The five ways a relayed submission is refused, published on both submit
 * routes so a client can branch on the status without reading the catalogue.
 *
 * They are five and not one because they call for different actions: fix the
 * request (400), use your own session (403), the chain said no and named it
 * (409), wait (429), try again shortly (503).
 */
const RELAYED_MALFORMED_DESCRIPTION =
  'SETTLEMENT_RELAYED_INTENT_MALFORMED — the signature is not 65 bytes of hex, or a uint64 ' +
  'field does not fit. Nothing was submitted.';

const RELAYED_ANOTHER_BUYER_DESCRIPTION =
  'SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER — the signed message names a buyer who is not this ' +
  "session's account. The CHAIN would accept such a submission (a genuine signature verifies " +
  'whoever sends it); the platform refuses because it is the platform that pays the gas.';

const RELAYED_REFUSED_DESCRIPTION =
  'SETTLEMENT_RELAYED_INTENT_REFUSED — the chain refused, by its own `Errors.sol` name: ' +
  '`BadNonce` (replayed, or another door consumed the shared `authNonce` first), ' +
  '`SignatureExpired`, `MalleableSignature`, `SignerIsNotBuyer`, `EscrowLimitsUnchanged`, ' +
  '`ProgramPaused`. `transactionHash` is absent when the pre-flight caught it and nothing was ' +
  'sent, and present when it was sent and reverted.';

const RELAYED_RATE_LIMITED_DESCRIPTION =
  'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED — this account or organization has spent its share ' +
  "of the relayer's gas budget for the window.";

const RELAYED_UNAVAILABLE_DESCRIPTION =
  'SETTLEMENT_RELAYED_INTENT_UNAVAILABLE — the submission budget could not be counted, so ' +
  'nothing was submitted. The signature is still valid until its deadline.';

@ApiTags('Escrow')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@ApiExtraModels(...UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS)
@Controller('escrow')
export class EscrowController {
  constructor(
    private readonly escrows: EscrowAccountService,
    private readonly withdrawals: WithdrawalService,
    private readonly audit: AuditLogWriter,
  ) {}

  /**
   * `GET /escrow` — everything a console needs to render the buyer's escrow.
   *
   * **`withdrawAvailableAt` is an instant, and `serverTime` is beside it.** A
   * client that rendered `now + withdrawDelaySeconds` would be wrong after
   * any `update_config`, and wrong in the direction that promises money
   * sooner than the chain will pay it.
   *
   * **This route degrades and the three `*-intent` routes below refuse.** A
   * chain the backend cannot read used to 500 here with whatever the decoder
   * threw; it now answers `chainReadable: false` with every chain-derived
   * field `null` and the database half of the screen intact. The difference
   * between the two is not the HTTP verb: it is that this route reports
   * numbers and the others *build a transaction naming the escrow's mint*,
   * which cannot be guessed. See `EscrowAccountService`.
   */
  @Get()
  @ApiOperation({
    summary: "Read this buyer's escrow: balance, limits, window meter and any pending withdrawal",
  })
  @ApiResponse({
    status: 200,
    type: GetEscrowResponseDto,
    description:
      'Always 200 when the session is valid. A chain that could not be read is reported as ' +
      '`chainReadable: false` with the chain-derived fields null — never as an error, and ' +
      'never as a stale reading.',
  })
  async get(@CurrentSession() session: McpSession): Promise<GetEscrowResponseDto> {
    const state = await this.escrows.getForConsole(session.organizationId, session.agentAccount);
    return toGetEscrowResponseDto(state);
  }

  /**
   * `GET /escrow/unsettled` — the payments the platform served and the chain
   * has not redeemed yet, beside the escrow's own window (BUG-D1-07). A console
   * shows them before the buyer lowers a limit, and polls this while waiting
   * for them to settle.
   *
   * The payer's own (HUMAN) session only, like `GET /escrow/delegates`: an
   * agent has no use for the payer-wide figures, and each read costs a chain
   * read.
   */
  @UseGuards(HumanSessionGuard)
  @Get('unsettled')
  @ApiOperation({ summary: "The payer's payments still being settled on chain" })
  @ApiResponse({ status: 200, type: GetEscrowUnsettledResponseDto })
  async unsettled(@CurrentSession() session: McpSession): Promise<GetEscrowUnsettledResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);
    const [unsettled, tightenDelaySeconds] = await Promise.all([
      this.withdrawals.unsettledVouchers(session.organizationId, session.agentAccount, asset),
      this.withdrawals.tightenDelaySeconds(session.agentAccount),
    ]);
    return {
      account: session.agentAccount,
      unsettled: unsettled === null ? null : toUnsettledDto(unsettled, asset),
      tightenDelaySeconds,
    };
  }

  /**
   * `POST /escrow/limits-intent` — the buyer's brake.
   *
   * **`0` means refuse every redeem, not "unlimited"** — a console that got
   * this backwards would tell a buyer they were unprotected while in fact no
   * call of theirs could be paid at all.
   */
  // The on-chain limits are the buyer's brake on its agent. The chain still
  // demands the wallet's signature; refusing the agent's credential here
  // keeps the API from even building or relaying the change for it.
  @Post('limits-intent')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: "Build the buyer's own set_escrow_limits transaction" })
  @ApiResponse({ status: 201, type: CreateEscrowIntentResponseDto })
  @ApiResponse({ status: 503, description: ESCROW_CHAIN_UNREADABLE_DESCRIPTION })
  async setLimits(
    @CurrentSession() session: McpSession,
    @Body() body: SetEscrowLimitsBodyDto,
  ): Promise<CreateEscrowIntentResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);
    const limits: EscrowLimits = {
      maxVoucherAmount: BigInt(body.maxVoucherAmount),
      maxPerWindow: BigInt(body.maxPerWindow),
    };

    const result = await this.withdrawals.buildIntent(
      session.organizationId,
      session.agentAccount,
      asset,
      {
        kind: EscrowIntentKind.SET_LIMITS,
        amount: null,
        limits,
        destination: null,
        acknowledgeUnsettled: body.acknowledgeUnsettled === true,
      },
    );

    return toResponseDto(EscrowIntentKind.SET_LIMITS, session.agentAccount, result);
  }

  /**
   * `POST /escrow/withdrawals/request-intent` — step 1 of 2.
   *
   * Starts the clock the program freezes at `now + Config.withdraw_delay_seconds`.
   * `amount: "0"` cancels a standing request.
   */
  // Withdrawing is the buyer taking money back out of the escrow its agent
  // spends from — a person's decision, like the limits. The chain still wants
  // the buyer's signature (or `msg.sender`); refusing the agent's credential
  // keeps the API from building or relaying any step of it on the agent's word.
  @Post('withdrawals/request-intent')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: "Build the buyer's own request_withdraw transaction" })
  @ApiResponse({ status: 201, type: CreateEscrowIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'Withdrawals are frozen (last reconciliation found a breach)',
  })
  @ApiResponse({ status: 503, description: ESCROW_CHAIN_UNREADABLE_DESCRIPTION })
  async requestWithdraw(
    @CurrentSession() session: McpSession,
    @Body() body: RequestWithdrawBodyDto,
  ): Promise<CreateEscrowIntentResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);
    const { decimals } = getAssetMetadata(asset);
    // `MoneyUtil.of`, not a literal: the DTO's `@Matches(/^\d+$/)` bounds the
    // string's shape but not its range, and a 32-digit string is a shape
    // `u64` cannot hold. `MoneyUtil.of` is what refuses it.
    const amount = MoneyUtil.of(body.amount, asset, decimals);

    const result = await this.withdrawals.buildIntent(
      session.organizationId,
      session.agentAccount,
      asset,
      { kind: EscrowIntentKind.REQUEST_WITHDRAW, amount, limits: null, destination: null },
    );

    return toResponseDto(EscrowIntentKind.REQUEST_WITHDRAW, session.agentAccount, result);
  }

  /**
   * `POST /escrow/limits` — **submit** the signature `limits-intent` asked for.
   *
   * The pair is deliberate and the naming carries it: `…-intent` builds
   * something to sign, the bare path sends what was signed. On `eip155` the
   * thing that was signed is an EIP-712 request and the platform's relayer pays
   * the gas; there is no equivalent on Solana, where the buyer signs and sends
   * their own transaction with their own SOL, and a Solana session is refused
   * `CHAIN_UNSUPPORTED` rather than answered.
   *
   * **The body is the issued message, echoed back, plus the signature.** Every
   * field is the one `POST /escrow/limits-intent` published; nothing here is
   * re-derived. The route encodes the call itself from those validated fields
   * against its own vendored ABI — it never forwards calldata, and no field in
   * this body can choose the target contract or the function.
   */
  @Post('limits')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: "Relay the buyer's signed set_escrow_limits request" })
  @ApiResponse({ status: 201, type: RelayedEscrowIntentResponseDto })
  @ApiResponse({ status: 400, description: RELAYED_MALFORMED_DESCRIPTION })
  @ApiResponse({ status: 403, description: RELAYED_ANOTHER_BUYER_DESCRIPTION })
  @ApiResponse({ status: 409, description: RELAYED_REFUSED_DESCRIPTION })
  @ApiResponse({ status: 429, description: RELAYED_RATE_LIMITED_DESCRIPTION })
  @ApiResponse({ status: 503, description: RELAYED_UNAVAILABLE_DESCRIPTION })
  async submitLimits(
    @CurrentSession() session: McpSession,
    @Body() body: SubmitSetLimitsBodyDto,
  ): Promise<RelayedEscrowIntentResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);

    const result = await this.withdrawals.submitRelayedIntent(
      session.organizationId,
      session.agentAccount,
      asset,
      body.buyer,
      {
        kind: EscrowIntentKind.SET_LIMITS,
        maxVoucherAmount: BigInt(body.maxVoucherAmount),
        maxPerWindow: BigInt(body.maxPerWindow),
        nonce: BigInt(body.nonce),
        deadline: BigInt(body.deadline),
        signature: body.signature,
      },
      body.acknowledgeUnsettled === true,
    );

    // The transaction has landed and there is no database transaction to join,
    // so the entry is written after the fact; a failure is logged, not thrown.
    // The signature is never part of it.
    await this.audit.recordAfterCommit({
      organizationId: session.organizationId,
      actor: auditActorOf(session),
      action: 'limit.updated',
      resourceType: 'escrow',
      resourceId: session.agentAccount,
      before: null,
      after: {
        maxVoucherAmount: body.maxVoucherAmount,
        maxPerWindow: body.maxPerWindow,
        transactionHash: result.submission.transactionHash,
      },
    });

    return toRelayedResponseDto(EscrowIntentKind.SET_LIMITS, session.agentAccount, result);
  }

  /**
   * `POST /escrow/withdrawals/request` — **submit** the signature
   * `withdrawals/request-intent` asked for.
   *
   * Refused while withdrawals are frozen, exactly as building one is: refusing
   * to build a withdrawal request during a known reserves shortfall and then
   * relaying one anyway would make the freeze mean nothing, since a buyer could
   * simply post bytes signed before it.
   *
   * This starts the one-hour clock; it pays nothing out. `withdraw()` is a
   * transaction the buyer sends themselves, it has no relayed form anywhere in
   * the contract, and nothing on this controller will ever send it for them.
   */
  @Post('withdrawals/request')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: "Relay the buyer's signed request_withdraw request" })
  @ApiResponse({ status: 201, type: RelayedEscrowIntentResponseDto })
  @ApiResponse({ status: 400, description: RELAYED_MALFORMED_DESCRIPTION })
  @ApiResponse({ status: 403, description: RELAYED_ANOTHER_BUYER_DESCRIPTION })
  @ApiResponse({
    status: 409,
    description: `${RELAYED_REFUSED_DESCRIPTION} Also SETTLEMENT_WITHDRAWALS_FROZEN.`,
  })
  @ApiResponse({ status: 429, description: RELAYED_RATE_LIMITED_DESCRIPTION })
  @ApiResponse({ status: 503, description: RELAYED_UNAVAILABLE_DESCRIPTION })
  async submitRequestWithdraw(
    @CurrentSession() session: McpSession,
    @Body() body: SubmitRequestWithdrawBodyDto,
  ): Promise<RelayedEscrowIntentResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);

    const result = await this.withdrawals.submitRelayedIntent(
      session.organizationId,
      session.agentAccount,
      asset,
      body.buyer,
      {
        kind: EscrowIntentKind.REQUEST_WITHDRAW,
        amount: BigInt(body.amount),
        nonce: BigInt(body.nonce),
        deadline: BigInt(body.deadline),
        signature: body.signature,
      },
    );

    // As for limits: the request has landed, so the entry is written after the
    // fact and a failure is logged, not thrown. `0` is the contract's cancel.
    // Bookkeeping only; the claim is logged by the withdrawal index.
    const cancelled = BigInt(body.amount) === 0n;
    await this.audit.recordAfterCommit({
      organizationId: session.organizationId,
      actor: auditActorOf(session),
      action: cancelled ? 'withdrawal.cancelled' : 'withdrawal.requested',
      resourceType: 'escrow',
      resourceId: session.agentAccount,
      before: null,
      after: {
        amount: body.amount,
        asset,
        withdrawAvailableAt: result.escrow.withdrawAvailableAt,
        transactionHash: result.submission.transactionHash,
      },
    });

    return toRelayedResponseDto(EscrowIntentKind.REQUEST_WITHDRAW, session.agentAccount, result);
  }

  /**
   * `POST /escrow/withdrawals/intent` — step 2 of 2.
   *
   * Pays `min(requested, escrow_ata.amount)`. Refused before
   * `withdrawAvailableAt` rather than built, so the buyer is not charged a
   * fee to be told something `GET /escrow` already knows.
   */
  @Post('withdrawals/intent')
  @UseGuards(HumanSessionGuard)
  @ApiOperation({ summary: "Build the buyer's own withdraw transaction" })
  @ApiResponse({ status: 201, type: CreateEscrowIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'No request outstanding, it has not matured yet, or withdrawals are frozen',
  })
  @ApiResponse({ status: 503, description: ESCROW_CHAIN_UNREADABLE_DESCRIPTION })
  async withdraw(
    @CurrentSession() session: McpSession,
    @Body() body: WithdrawBodyDto,
  ): Promise<CreateEscrowIntentResponseDto> {
    const asset = await this.escrows.assetFor(session.agentAccount);
    // `body.destination` is chain-native (a bare Solana address), the same
    // wire convention `CreatePayoutChallengeBodyDto` uses — never a CAIP-10
    // string the console would have to construct. Wrapped here, against the
    // session's own chain, before it reaches the builder, which speaks only
    // `AccountId`.
    const destination = body.destination ? toAccountId(session.chainId, body.destination) : null;

    const result = await this.withdrawals.buildIntent(
      session.organizationId,
      session.agentAccount,
      asset,
      { kind: EscrowIntentKind.WITHDRAW, amount: null, limits: null, destination },
    );

    return toResponseDto(EscrowIntentKind.WITHDRAW, session.agentAccount, result);
  }
}

function toResponseDto(
  kind: EscrowIntentKind,
  account: AccountId,
  result: EscrowIntentResult,
): CreateEscrowIntentResponseDto {
  return {
    kind,
    account,
    transaction: toUnsignedChainTransactionDto(result.transaction),
    escrow: toGetEscrowResponseDto(result.escrow),
    gasGrant: toWithdrawGasGrantDto(result.gasGrant),
  };
}

/**
 * The grant, flattened for the wire — and **narrowed** on the way out.
 *
 * `GRANTED` carries a `wei` the port knows and this DTO does not publish; see
 * `WithdrawGasGrantDto`'s comment for why the amount and the caps stay on this
 * side. Written as an exhaustive `switch` on the discriminant rather than a
 * spread, so a new outcome kind is a compile error here instead of a field that
 * silently arrives as `undefined` on a money screen.
 */
function toWithdrawGasGrantDto(grant: WithdrawGasGrant | null): WithdrawGasGrantDto | null {
  if (grant === null) return null;

  switch (grant.kind) {
    case 'GRANTED':
      return { status: 'GRANTED', reason: null, transactionHash: grant.hash };
    case 'REFUSED':
      return { status: 'REFUSED', reason: grant.reason, transactionHash: null };
    case 'UNAVAILABLE':
      return { status: 'UNAVAILABLE', reason: null, transactionHash: null };
  }
}

function toGetEscrowResponseDto(state: EscrowState): GetEscrowResponseDto {
  return {
    exists: state.exists,
    chainReadable: state.chainReadable,
    account: state.account,
    escrowPda: state.escrowPda,
    escrowTokenAccount: state.escrowTokenAccount,
    balance: state.balance,
    openHolds: state.openHolds,
    spendable: state.spendable,
    withdrawRequested: state.withdrawRequested,
    withdrawAvailableAt: state.withdrawAvailableAt,
    serverTime: state.serverTime,
    withdrawDelaySeconds: state.withdrawDelaySeconds,
    maxVoucherAmount: state.maxVoucherAmount,
    maxPerWindow: state.maxPerWindow,
    spentInWindow: state.spentInWindow,
    windowStartedAt: state.windowStartedAt,
    windowSeconds: state.windowSeconds,
    seqHigh: state.seqHigh,
    nextSeq: state.nextSeq,
    observedAt: state.observedAt,
    lifetime: state.lifetime,
  };
}

function toRelayedResponseDto(
  kind: EscrowIntentKind.SET_LIMITS | EscrowIntentKind.REQUEST_WITHDRAW,
  account: AccountId,
  result: RelayedEscrowIntentResult,
): RelayedEscrowIntentResponseDto {
  return {
    kind,
    account,
    transactionHash: result.submission.transactionHash,
    blockNumber: result.submission.blockNumber,
    gasUsed: result.submission.gasUsed,
    escrow: toGetEscrowResponseDto(result.escrow),
  };
}
