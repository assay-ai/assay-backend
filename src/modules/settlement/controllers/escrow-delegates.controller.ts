import { Body, Controller, Get, Logger, Optional, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS,
  toUnsignedChainTransactionDto,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { AgentCredentialRepository } from '@database/postgres/repositories/agent-credential.repository';
import { SessionEvictions } from '@modules/auth/session-cache/session-evictions.service';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { AuditLogWriter, auditActorOf } from '@shared/audit';
import {
  AllowedWhileBlocked,
  CurrentSession,
  HumanSessionGuard,
  SessionAuthGuard,
} from '@shared/auth';

import {
  CreateDelegateIntentBodyDto,
  CreateRevokeDelegateIntentBodyDto,
  DelegateIntentResponseDto,
  EscrowDelegateDto,
  ListEscrowDelegatesResponseDto,
  RelayedDelegateResponseDto,
  SubmitAuthorizeDelegateBodyDto,
  SubmitRevokeDelegateBodyDto,
} from '../dto/escrow-delegates.dto';
import { toUnsettledDto } from '../dto/get-escrow.dto';
import { EscrowDelegationKind } from '../ports/escrow-delegation.port';
import {
  delegateOn,
  EscrowDelegationService,
  EscrowDelegationWithUnsettled,
  RelayedDelegationResult,
} from '../services/escrow-delegation.service';
import { TenantCache } from '@shared/decorators/tenant-cache.decorator';

/**
 * `/escrow/delegates` — agent payment delegation (x402-aligned).
 *
 * A payer whose wallet key cannot leave its wallet (a Privy embedded wallet)
 * authorises a DELEGATE key — the one its headless agent holds — to sign rail-B
 * vouchers on the payer's escrow, within caps no higher than the escrow's own
 * and until `validUntil`; and revokes it. Both are EIP-712 messages the payer
 * signs once in the browser and the platform relays, like the escrow limits.
 *
 * **Every route is HUMAN-only.** Delegation is the payer's control over what
 * its agent may spend; the agent's own credential must not be able to build,
 * relay or even list it — the same line `HumanSessionGuard` draws for the
 * escrow limits and the spend policy.
 *
 * Authorising a key an agent credential holds as PENDING (a rebinding) is
 * also the approval that makes it that credential's bound key.
 */
@ApiTags('Escrow')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@ApiExtraModels(...UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS)
@Controller('escrow/delegates')
export class EscrowDelegatesController {
  private readonly logger = new Logger(EscrowDelegatesController.name);

  constructor(
    private readonly delegation: EscrowDelegationService,
    private readonly audit: AuditLogWriter,
    private readonly credentials: AgentCredentialRepository,
    @Optional() private readonly sessions: SessionEvictions | null = null,
  ) {}

  /** `GET /escrow/delegates` — the payer's standing delegates, read from the chain. */
  @Get()
  @TenantCache({ ttl: 5, vary: 'agent', epochs: ['money'], singleFlight: true })
  @ApiOperation({ summary: "List the payer's voucher delegates, from the chain" })
  @ApiResponse({ status: 200, type: ListEscrowDelegatesResponseDto })
  async list(@CurrentSession() session: McpSession): Promise<ListEscrowDelegatesResponseDto> {
    const asset = await this.delegation.assetFor(session.agentAccount);
    const [delegates, tightenDelaySeconds] = await Promise.all([
      this.delegation.list(session.agentAccount),
      this.delegation.tightenDelaySeconds(session.agentAccount),
    ]);
    return {
      account: session.agentAccount,
      delegates: delegates.map((d) => toDto(d, asset)),
      tightenDelaySeconds,
    };
  }

  /** `POST /escrow/delegates/intent` — the `AuthorizeDelegate` request the payer signs. */
  @Post('intent')
  @ApiOperation({ summary: 'Build the AuthorizeDelegate request the payer signs' })
  @ApiResponse({ status: 201, type: DelegateIntentResponseDto })
  @ApiResponse({ status: 400, description: 'SETTLEMENT_DELEGATION_INVALID' })
  @ApiResponse({
    status: 409,
    description:
      'SETTLEMENT_UNSETTLED_VOUCHERS_AT_RISK — the new caps would strand payments still being ' +
      'settled; send acknowledgeUnsettled to accept it',
  })
  @ApiResponse({
    status: 429,
    description: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED — before anything is signed',
  })
  async authorizeIntent(
    @CurrentSession() session: McpSession,
    @Body() body: CreateDelegateIntentBodyDto,
  ): Promise<DelegateIntentResponseDto> {
    const transaction = await this.delegation.authorizeIntent(
      session.organizationId,
      session.agentAccount,
      {
        delegate: delegateOn(session.agentAccount, body.delegate),
        maxVoucherAmount: BigInt(body.maxVoucherAmount),
        maxPerWindow: BigInt(body.maxPerWindow),
        validUntil: BigInt(body.validUntil),
      },
      body.acknowledgeUnsettled === true,
    );
    return {
      kind: EscrowDelegationKind.AUTHORIZE_DELEGATE,
      account: session.agentAccount,
      transaction: toUnsignedChainTransactionDto(transaction),
    };
  }

  /** `POST /escrow/delegates` — relay the signed `AuthorizeDelegate` (`authorizeDelegateBySig`). */
  @Post()
  @ApiOperation({ summary: "Relay the payer's signed AuthorizeDelegate request" })
  @ApiResponse({ status: 201, type: RelayedDelegateResponseDto })
  @ApiResponse({ status: 403, description: 'SETTLEMENT_RELAYED_INTENT_FOR_ANOTHER_BUYER' })
  @ApiResponse({
    status: 409,
    description: 'SETTLEMENT_RELAYED_INTENT_REFUSED — by the chain, by name',
  })
  @ApiResponse({ status: 429, description: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED' })
  async authorize(
    @CurrentSession() session: McpSession,
    @Body() body: SubmitAuthorizeDelegateBodyDto,
  ): Promise<RelayedDelegateResponseDto> {
    const result = await this.delegation.submit(
      session.organizationId,
      session.agentAccount,
      body.payer,
      {
        kind: EscrowDelegationKind.AUTHORIZE_DELEGATE,
        delegate: body.delegate,
        maxVoucherAmount: BigInt(body.maxVoucherAmount),
        maxPerWindow: BigInt(body.maxPerWindow),
        validUntil: BigInt(body.validUntil),
        nonce: BigInt(body.nonce),
        deadline: BigInt(body.deadline),
        signature: body.signature,
      },
      body.acknowledgeUnsettled === true,
    );
    await this.recordDelegateChange(session, 'signer.authorized', body.delegate, {
      maxVoucherAmount: body.maxVoucherAmount,
      maxPerWindow: body.maxPerWindow,
      validUntil: new Date(Number(body.validUntil) * 1000).toISOString(),
      transactionHash: result.submission.transactionHash,
    });
    await this.promotePending(session, delegateOn(session.agentAccount, body.delegate));
    return toRelayedDto(EscrowDelegationKind.AUTHORIZE_DELEGATE, session.agentAccount, result);
  }

  /** `POST /escrow/delegates/revoke-intent` — the `RevokeDelegate` request the payer signs. */
  @Post('revoke-intent')
  @AllowedWhileBlocked()
  @ApiOperation({ summary: 'Build the RevokeDelegate request the payer signs' })
  @ApiResponse({ status: 201, type: DelegateIntentResponseDto })
  @ApiResponse({ status: 409, description: 'SETTLEMENT_DELEGATION_NOT_ACTIVE' })
  @ApiResponse({
    status: 429,
    description: 'SETTLEMENT_RELAYED_INTENT_RATE_LIMITED — before anything is signed',
  })
  async revokeIntent(
    @CurrentSession() session: McpSession,
    @Body() body: CreateRevokeDelegateIntentBodyDto,
  ): Promise<DelegateIntentResponseDto> {
    const transaction = await this.delegation.revokeIntent(
      session.organizationId,
      session.agentAccount,
      body.delegate,
    );
    return {
      kind: EscrowDelegationKind.REVOKE_DELEGATE,
      account: session.agentAccount,
      transaction: toUnsignedChainTransactionDto(transaction),
    };
  }

  /** `POST /escrow/delegates/revoke` — relay the signed `RevokeDelegate` (`revokeDelegateBySig`). */
  @Post('revoke')
  @AllowedWhileBlocked()
  @ApiOperation({ summary: "Relay the payer's signed RevokeDelegate request" })
  @ApiResponse({ status: 201, type: RelayedDelegateResponseDto })
  async revoke(
    @CurrentSession() session: McpSession,
    @Body() body: SubmitRevokeDelegateBodyDto,
  ): Promise<RelayedDelegateResponseDto> {
    const result = await this.delegation.submit(
      session.organizationId,
      session.agentAccount,
      body.payer,
      {
        kind: EscrowDelegationKind.REVOKE_DELEGATE,
        delegate: body.delegate,
        nonce: BigInt(body.nonce),
        deadline: BigInt(body.deadline),
        signature: body.signature,
      },
    );
    await this.recordDelegateChange(session, 'signer.revoked', body.delegate, {
      revoked: true,
      transactionHash: result.submission.transactionHash,
    });
    return toRelayedDto(EscrowDelegationKind.REVOKE_DELEGATE, session.agentAccount, result);
  }

  /**
   * The payer's approval of a key an agent credential holds as PENDING (it
   * proved the key while another was bound) is what makes it the bound key:
   * one UPDATE, after the authorisation landed on chain. The old key's grant
   * stays on chain until the payer revokes it, but no credential signs with
   * it any more. A failure leaves the old binding in place and is logged: the
   * approval itself succeeded and must still be answered.
   */
  private async promotePending(session: McpSession, delegate: AccountId): Promise<void> {
    try {
      const promoted = await this.credentials.promotePendingDelegate(
        session.organizationId,
        session.agentId,
        delegate,
      );
      if (promoted.length === 0) return;
      // The session carries `delegateAccount`: a cached one would still name the old key.
      await this.sessions?.evictOrganization(session.organizationId);
    } catch (error) {
      this.logger.warn(
        `pending delegate not promoted: ${(error as Error)?.message ?? String(error)}`,
      );
    }
  }

  /**
   * The relayed transaction has landed and there is no database transaction to
   * join, so the entry is written after the fact; a failure is logged, not
   * thrown. The payer's signature is never part of it.
   */
  private recordDelegateChange(
    session: McpSession,
    action: 'signer.authorized' | 'signer.revoked',
    delegate: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.recordAfterCommit({
      organizationId: session.organizationId,
      actor: auditActorOf(session),
      action,
      resourceType: 'escrow_delegate',
      resourceId: delegateOn(session.agentAccount, delegate),
      before: null,
      after,
    });
  }
}

function toDto(d: EscrowDelegationWithUnsettled, asset: AssetId): EscrowDelegateDto {
  const { decimals } = getAssetMetadata(asset);
  const money = (amount: bigint) => ({ amount: amount.toString(), asset, decimals });
  return {
    delegate: d.delegate,
    maxVoucherAmount: money(d.maxVoucherAmount),
    maxPerWindow: money(d.maxPerWindow),
    spentInWindow: money(d.spentInWindow),
    validUntil: new Date(Number(d.validUntil) * 1000).toISOString(),
    status: d.status,
    unsettled: toUnsettledDto(d.unsettled, asset),
  };
}

function toRelayedDto(
  kind: EscrowDelegationKind,
  account: AccountId,
  result: RelayedDelegationResult,
): RelayedDelegateResponseDto {
  return {
    kind,
    account,
    transactionHash: result.submission.transactionHash,
    blockNumber: result.submission.blockNumber,
    gasUsed: result.submission.gasUsed,
    delegates:
      result.delegates === null ? null : result.delegates.map((d) => toDto(d, result.asset)),
  };
}
