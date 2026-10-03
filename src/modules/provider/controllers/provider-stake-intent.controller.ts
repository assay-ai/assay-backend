import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS } from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { McpSession } from '@modules/mcp/ports/mcp-session.port';
import { CurrentSession, SessionAuthGuard } from '@shared/auth';

import {
  CreateStakeIntentBodyDto,
  CreateStakeIntentResponseDto,
} from '../dto/create-stake-intent.dto';
import { StakeIntentKind } from '../ports/stake-intent-builder.port';
import { ProviderStakeIntentService } from '../services/provider-stake-intent.service';

/**
 * `POST /providers/me/stake/{open-stake|deposit|unstake|withdraw}-intent`.
 *
 * Four routes rather than one with a `kind` field, because they are four
 * different acts with four different preconditions and four different ways to
 * be refused — and because a console's "Deposit" button should not be one
 * mistyped enum away from a withdrawal.
 *
 * **`POST` on something that writes nothing.** These endpoints build bytes;
 * they do not move money, they do not persist a row, and re-issuing one is
 * harmless. `GET` would nevertheless be wrong twice over: the amount is a
 * request body rather than a path, and — the reason that actually matters — a
 * `GET` is what HTTP caches, proxies and browser histories are entitled to
 * keep, and these responses carry a provider's balances. An earlier
 * cross-tenant cache leak is the precedent for taking that seriously.
 *
 * `organizationId` comes from `@CurrentSession()` only. There is no field
 * anywhere on these requests naming the stake account: it is read from
 * `providers.stake_authority`, which only the challenge/prove flow writes, for
 * the reason `ProveStakeAuthorityBodyDto` gives at length.
 *
 * Every route returns an **unsigned** transaction. The backend never holds a
 * provider's key and never signs these — see `ProviderStakeIntentService` and
 * `StakeIntentBuilderPort`, where that is structural rather than a convention.
 */
@ApiTags('Provider')
@ApiBearerAuth()
@UseGuards(SessionAuthGuard)
@ApiExtraModels(...UNSIGNED_CHAIN_TRANSACTION_EXTRA_MODELS)
@Controller('providers/me/stake')
export class ProviderStakeIntentController {
  constructor(private readonly intents: ProviderStakeIntentService) {}

  @Post('open-stake-intent')
  @ApiOperation({
    summary: 'Open the on-chain stake account — the first step, and nothing works without it',
    description:
      '`open_stake` is a separate instruction and deliberately not `init_if_needed`, and ' +
      '`deposit_stake` requires an already-existing stake account. **You pay rent for your own ' +
      'account**: the preflight quotes it before you sign. Takes no body — the instruction ' +
      'carries no amount and moves no tokens.',
  })
  @ApiResponse({ status: 201, type: CreateStakeIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'No proved stake authority, or the account is already open',
  })
  @ApiResponse({ status: 503, description: 'The chain could not be read; nothing was built' })
  async openStake(@CurrentSession() session: McpSession): Promise<CreateStakeIntentResponseDto> {
    return this.intents.createIntent(session.organizationId, StakeIntentKind.OPEN_STAKE, null);
  }

  @Post('deposit-intent')
  @ApiOperation({
    summary: 'Move stake in — the deposit flow with the gas preflight',
    description:
      'Staking needs USDC on Solana **and** SOL for gas. Both requirements, and both current ' +
      'balances, are on the response before a wallet ever opens; gas is deliberately not ' +
      'sponsored and `preflight.gasNotSponsoredReason` says why.',
  })
  @ApiResponse({ status: 201, type: CreateStakeIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'No proved stake authority, or the account is not open yet',
  })
  @ApiResponse({ status: 503, description: 'The chain could not be read; nothing was built' })
  async deposit(
    @CurrentSession() session: McpSession,
    @Body() body: CreateStakeIntentBodyDto,
  ): Promise<CreateStakeIntentResponseDto> {
    return this.intents.createIntent(session.organizationId, StakeIntentKind.DEPOSIT, body.amount);
  }

  @Post('unstake-intent')
  @ApiOperation({
    summary: 'Start the unbonding clock on part of the bonded stake',
    description:
      'Moves stake from `bonded` to `unbonding`. It stays fully slashable for the whole period ' +
      '— that is what the period is for — and it stops counting towards the routing gate ' +
      'immediately, because `meets_minimum` reads `bonded` alone.',
  })
  @ApiResponse({ status: 201, type: CreateStakeIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'No proved stake authority, or the account is not open yet',
  })
  @ApiResponse({ status: 503, description: 'The chain could not be read; nothing was built' })
  async unstake(
    @CurrentSession() session: McpSession,
    @Body() body: CreateStakeIntentBodyDto,
  ): Promise<CreateStakeIntentResponseDto> {
    return this.intents.createIntent(session.organizationId, StakeIntentKind.UNSTAKE, body.amount);
  }

  @Post('withdraw-intent')
  @ApiOperation({
    summary: 'Take matured, unexposed stake out — and say which limit bit if it cannot',
    description:
      'Returns `withdrawable` alongside `blockedBy`: `UNBONDING_NOT_MATURED` resolves with ' +
      'time, `EXPOSURE` resolves only when calls settle. A blocked withdrawal returns **no ' +
      'transaction** — `withdraw_stake` would reject it, and discovering that costs a network ' +
      'fee. Still a `201`: the request was answered, and the answer is the limit.',
  })
  @ApiResponse({ status: 201, type: CreateStakeIntentResponseDto })
  @ApiResponse({
    status: 409,
    description: 'No proved stake authority, or the account is not open yet',
  })
  @ApiResponse({ status: 503, description: 'The chain could not be read; nothing was built' })
  async withdraw(
    @CurrentSession() session: McpSession,
    @Body() body: CreateStakeIntentBodyDto,
  ): Promise<CreateStakeIntentResponseDto> {
    return this.intents.createIntent(session.organizationId, StakeIntentKind.WITHDRAW, body.amount);
  }
}
