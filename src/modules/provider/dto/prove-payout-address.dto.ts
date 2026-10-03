import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

import { ProofTypedDataDto } from './proof-typed-data.dto';

/**
 * `POST /providers/me/payout-address/challenge` — the console asks the
 * platform for a nonce to sign, naming the wallet it wants to prove.
 *
 * The address is accepted as a **chain id plus a chain-native address**
 * (`solana:5eykt…` / `7xKXtg2CW…`), matching the console's plain
 * "Solana address" field and matching how `ChainAdapterRegistry` resolves an
 * adapter everywhere else — a bare address means nothing without knowing
 * which chain it is validated against. A CAIP-10 `AccountId` was the other
 * option; two fields wins because the console never has to string-concatenate
 * one, and `ProviderPayoutAddressService` validates and re-wraps it into the
 * canonical `AccountId` through `ChainAdapter.isValidAddress` /
 * `toAccountId` before it is stored, so this DTO never has to enforce the
 * grammar itself.
 */
export class CreatePayoutChallengeBodyDto {
  @ApiProperty({
    description: 'CAIP-2 chain id the payout address lives on',
    example: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  chainId: string;

  @ApiProperty({
    description: 'Chain-native address, not a CAIP-10 id — e.g. a base58 Solana address',
    example: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  address: string;
}

/**
 * What the console shows next to "Sign a nonce to prove you control this
 * wallet". `message` is the exact string the wallet must be asked to sign —
 * the console does not, and must not, construct it locally, because the
 * stored `provider_payout_challenges.message` row is the only copy
 * `ProviderPayoutAddressService.prove` ever verifies against.
 */
export class CreatePayoutChallengeResponseDto {
  @ApiProperty({ description: 'Pass this back to POST /providers/me/payout-address' })
  challengeId: string;

  @ApiProperty({ description: '32 random bytes, lower-case hex' })
  nonce: string;

  @ApiProperty({ description: 'The exact bytes to sign, as the wallet must render them' })
  message: string;

  @ApiProperty({ description: 'Leads `message` — see `PAYOUT_PROOF_MESSAGE_VERSION`' })
  messageVersion: string;

  @ApiProperty({ description: 'CAIP-10 — the canonical form of the address being claimed' })
  accountId: string;

  @ApiProperty({ description: 'ISO-8601. The challenge cannot be redeemed after this' })
  expiresAt: Date;

  @ApiProperty({
    type: ProofTypedDataDto,
    nullable: true,
    description:
      'eip155: the EIP-712 request the wallet signs (and the signature returns as 0x hex). ' +
      'null on Solana, where `message` itself is what is signed.',
  })
  typedData: ProofTypedDataDto | null;
}

/**
 * `POST /providers/me/payout-address` — redeem a signed challenge.
 *
 * Deliberately **only** `challengeId` and `signature`. Neither the address
 * nor the message is accepted here: both already live on the
 * `provider_payout_challenges` row the `challengeId` points at, and
 * `ProviderPayoutAddressService.prove` reads them from there. Accepting
 * either from the request body would let the caller — not the platform —
 * decide what the signature is being checked against, which is the exact
 * failure mode `ChainAdapter`'s "no generic verify" argument exists to
 * prevent one level up.
 */
export class ProvePayoutAddressBodyDto {
  @ApiProperty({ description: 'From `POST /providers/me/payout-address/challenge`' })
  @IsUUID()
  challengeId: string;

  @ApiProperty({
    description:
      'Solana: base58 ed25519 over `message`. eip155: 0x-hex (65 bytes, 132 characters) ' +
      'EIP-712 signature over `typedData`.',
  })
  @IsString()
  @IsNotEmpty()
  // 128 fit a base58 ed25519 signature (~88) and refused every eip155 one:
  // 65 bytes of hex plus `0x` is 132.
  @MaxLength(256)
  signature: string;
}

export class PayoutProofDto {
  @ApiProperty()
  challengeId: string;

  @ApiProperty()
  signature: string;

  @ApiProperty()
  messageVersion: string;

  @ApiProperty({ description: 'ISO-8601' })
  provedAt: string;
}

export class ProvePayoutAddressResponseDto {
  @ApiProperty({
    description:
      'CAIP-10 — now proved, and now the address the platform pays this provider at ON THIS ' +
      "ADDRESS'S OWN CHAIN. One enrolment per chain: proving an address here " +
      'changes nothing about any other chain the provider is enrolled on.',
  })
  payoutAccountId: string;

  @ApiProperty({ description: 'ISO-8601' })
  provedAt: Date;

  @ApiProperty({ type: PayoutProofDto })
  proof: PayoutProofDto;
}
