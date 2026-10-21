import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

import {
  UnsignedChainTransactionDto,
  unsignedChainTransactionSchema,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { MoneyDto } from '@modules/ledger/dto/get-balances.dto';

import { StakeWithdrawalBlocker } from '../domain/stake-withdrawal';
import { StakeIntentKind } from '../ports/stake-intent-builder.port';

/**
 * The body of `deposit-intent`, `unstake-intent` and `withdraw-intent`.
 *
 * `open-stake-intent` takes **no body at all**: `open_stake` carries no
 * argument and moves no tokens, and a body with an ignored field is a body
 * somebody will eventually fill in expecting it to matter.
 *
 * The asset is not on the request, deliberately. Stake is denominated in
 * `Config.stake_mint` and in nothing else — the program will accept no other
 * mint — so a caller-supplied asset could only ever be right or rejected, and
 * accepting the field would invite a console to send the value it happens to
 * hold rather than the one the chain names.
 */
export class CreateStakeIntentBodyDto {
  @ApiProperty({
    description:
      'Atomic units of the stake asset, as a decimal integer string. Never a decimal number — ' +
      'see `chains/ports/money.types.ts` for why money is not a `number` anywhere in this system.',
    example: '50000000',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  @Matches(/^\d+$/, { message: 'amount must be a non-negative decimal integer string' })
  @Matches(/[1-9]/, { message: 'amount must be greater than 0' })
  amount: string;
}

/** What the screen renders above the "Sign in your wallet" button. */
export class StakeIntentPreflightDto {
  @ApiProperty({
    type: MoneyDto,
    description:
      'How much of the stake asset this act moves. `"0"` for every kind but DEPOSIT — an ' +
      'unstake starts a clock, a withdrawal moves money out, and open-stake touches no token ' +
      'account at all.',
  })
  requiredStakeAsset: MoneyDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      "What the stake authority's own token account holds, or **null when there is no such " +
      'account**. Null is not zero: a provider with no associated token account needs one ' +
      'created, while a provider with an empty one needs USDC, and those are different errands.',
  })
  stakeAssetBalance: MoneyDto | null;

  @ApiProperty({
    type: MoneyDto,
    description:
      "The gas budget, in the chain's native asset (SOL, 9 decimals). A deliberate ceiling of " +
      '~0.01 rather than a quote — the largest of the four acts is open-stake, which pays ' +
      "rent-exemption for the stake account out of the provider's own pocket.",
  })
  requiredGas: MoneyDto;

  @ApiProperty({
    type: MoneyDto,
    description: 'What the stake authority holds of the native asset right now.',
  })
  gasBalance: MoneyDto;

  @ApiProperty({
    description:
      '`requiredStakeAsset` is covered by `stakeAssetBalance`. **False when the balance is ' +
      'unknown** — an absent token account is never read as enough.',
  })
  hasEnoughStakeAsset: boolean;

  @ApiProperty({ description: '`requiredGas` is covered by `gasBalance`' })
  hasEnoughGas: boolean;

  @ApiProperty({
    description:
      "Always false. The platform sponsors gas for an agent's x402 payment through the " +
      'facilitator — a call the agent did not choose to make on a chain they may not hold SOL ' +
      'on. It does not sponsor this one.',
  })
  gasSponsored: boolean;

  @ApiProperty({
    description:
      'The gas-sponsorship reason in one sentence, so the screen prints the platform’s reason ' +
      'and not its own',
    example:
      'You pay the network fee yourself: sponsoring an intentional financial act invites griefing.',
  })
  gasNotSponsoredReason: string;
}

/**
 * `POST /providers/me/stake/{open-stake|deposit|unstake|withdraw}-intent`.
 *
 * ## One shape for four intents
 *
 * The four differ in exactly two fields — `amount` is null for open-stake, and
 * `withdrawable`/`blockedBy` are populated only for a withdrawal — so four
 * response types would have been four Swagger entries and four client branches
 * over one flow. What every one of them carries is the same: a preflight, and
 * either a transaction or the reason there is not one.
 *
 * ## `transaction` is nullable, and that is the feature
 *
 * A withdrawal the chain would reject is not returned. `withdraw_stake`
 * enforces `amount <= withdrawable`, so handing over a transaction for more
 * than that would charge the provider a network fee to be told something this
 * response already knows. When `blockedBy` is set, `transaction` is `null` and
 * `withdrawable` says what would have gone through.
 *
 * Every other kind either builds or throws — there is no partial answer for a
 * deposit.
 */
export class CreateStakeIntentResponseDto {
  @ApiProperty({ enum: StakeIntentKind })
  kind: StakeIntentKind;

  @ApiProperty({
    description:
      'The CAIP-10 stake authority this transaction is built for — `providers.stake_authority`, ' +
      'written by the challenge/prove flow. Never taken from the request: a request that could ' +
      'name the account is a request provider A could point at provider B.',
  })
  account: string;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description: 'The amount the instruction carries. Null for OPEN_STAKE, which carries none.',
  })
  amount: MoneyDto | null;

  @ApiPropertyOptional({
    ...unsignedChainTransactionSchema(),
    nullable: true,
    description:
      'One of the three members of `UnsignedChainTransaction` — on Solana, the compiled ' +
      'unsigned wire transaction. Null only on a withdrawal that `blockedBy` explains; see the ' +
      'class comment for why a transaction the chain would reject is not returned.',
  })
  transaction: UnsignedChainTransactionDto | null;

  @ApiProperty({ type: StakeIntentPreflightDto })
  preflight: StakeIntentPreflightDto;

  @ApiPropertyOptional({
    type: MoneyDto,
    nullable: true,
    description:
      'WITHDRAW only. What `withdraw_stake` would accept right now — ' +
      '`min(matured unbonding, bonded + unbonding − effective exposure)`, computed as the ' +
      'program computes it. Null for the other three kinds.',
  })
  withdrawable: MoneyDto | null;

  @ApiPropertyOptional({
    enum: StakeWithdrawalBlocker,
    nullable: true,
    description:
      'WITHDRAW only, and null when the requested amount is within `withdrawable`. Which of the ' +
      'two limits bit: `UNBONDING_NOT_MATURED` resolves with time, `EXPOSURE` resolves only ' +
      'when calls settle — completely different situations for someone waiting on money. When ' +
      'both bite, this is `UNBONDING_NOT_MATURED`, because the program checks maturity first ' +
      'and returns zero outright.',
  })
  blockedBy: StakeWithdrawalBlocker | null;
}
