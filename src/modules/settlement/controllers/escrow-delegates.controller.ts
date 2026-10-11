import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import {
  UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS,
  toUnsignedChainTransactionDto,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { getAssetMetadata } from '@modules/chains/ports/asset-registry';
import { AccountId, AssetId } from '@modules/chains/ports/caip.types';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

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
import { EscrowDelegation, EscrowDelegationKind } from '../ports/escrow-delegation.port';
import {
  delegateOn,
  EscrowDelegationService,
  RelayedDelegationResult,
} from '../services/escrow-delegation.service';

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
 */
@ApiTags('Escrow')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard, HumanSessionGuard)
@ApiExtraModels(...UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS)
@Controller('escrow/delegates')
export class EscrowDelegatesController {
  constructor(private readonly delegation: EscrowDelegationService) {}

  /** `GET /escrow/delegates` — the payer's standing delegates, read from the chain. */
  @Get()
  @ApiOperation({ summary: "List the payer's voucher delegates, from the chain" })
  @ApiResponse({ status: 200, type: ListEscrowDelegatesResponseDto })
  async list(@CurrentSession() session: McpSession): Promise<ListEscrowDelegatesResponseDto> {
    const asset = await this.delegation.assetFor(session.agentAccount);
    const delegates = await this.delegation.list(session.agentAccount);
    return { account: session.agentAccount, delegates: delegates.map((d) => toDto(d, asset)) };
  }

  /** `POST /escrow/delegates/intent` — the `AuthorizeDelegate` request the payer signs. */
  @Post('intent')
  @ApiOperation({ summary: 'Build the AuthorizeDelegate request the payer signs' })
  @ApiResponse({ status: 201, type: DelegateIntentResponseDto })
  @ApiResponse({ status: 400, description: 'SETTLEMENT_DELEGATION_INVALID' })
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
    );
    return toRelayedDto(EscrowDelegationKind.AUTHORIZE_DELEGATE, session.agentAccount, result);
  }

  /** `POST /escrow/delegates/revoke-intent` — the `RevokeDelegate` request the payer signs. */
  @Post('revoke-intent')
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
    return toRelayedDto(EscrowDelegationKind.REVOKE_DELEGATE, session.agentAccount, result);
  }
}

function toDto(d: EscrowDelegation, asset: AssetId): EscrowDelegateDto {
  const { decimals } = getAssetMetadata(asset);
  const money = (amount: bigint) => ({ amount: amount.toString(), asset, decimals });
  return {
    delegate: d.delegate,
    maxVoucherAmount: money(d.maxVoucherAmount),
    maxPerWindow: money(d.maxPerWindow),
    spentInWindow: money(d.spentInWindow),
    validUntil: new Date(Number(d.validUntil) * 1000).toISOString(),
    status: d.status,
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
