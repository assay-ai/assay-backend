import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUUID, MaxLength } from 'class-validator';

import { ProofTypedDataDto } from './proof-typed-data.dto';

/**
 * `POST /providers/me/stake-authority/challenge` — the console asks the
 * platform for a nonce to sign, naming the wallet that opened the on-chain
 * stake account (`ProviderStake` PDA, seeds `["stake", provider_pubkey]`).
 *
 * The shape mirrors `CreatePayoutChallengeBodyDto` — a CAIP-2 chain id plus a
 * chain-native address — for the reason given there: a bare address means
 * nothing without knowing which chain validated it, and
 * `ChainAdapterRegistry` resolves an adapter by chain id everywhere else.
 *
 * The chain id is load-bearing here in a way it is not for a payout address.
 * `stake_authority` holds the CAIP-10 form, so the chain travels with the key
 * and a devnet stake account can never be read as the mainnet one whose PDA a
 * slash attestation would point at.
 */
export class CreateStakeAuthorityChallengeBodyDto {
  @ApiProperty({
    description: 'CAIP-2 chain id the stake account lives on',
    example: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  chainId: string;

  @ApiProperty({
    description: 'Chain-native address, not a CAIP-10 id — the pubkey that opened the stake PDA',
    example: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  address: string;
}

/**
 * What the console shows next to "Sign a nonce to prove you control this
 * stake wallet". `message` is the exact string the wallet must be asked to
 * sign — the console does not, and must not, construct it locally, because
 * the stored `provider_payout_challenges.message` row is the only copy
 * `ProviderStakeAuthorityService.prove` ever verifies against.
 */
export class CreateStakeAuthorityChallengeResponseDto {
  @ApiProperty({ description: 'Pass this back to POST /providers/me/stake-authority' })
  challengeId: string;

  @ApiProperty({ description: '32 random bytes, lower-case hex' })
  nonce: string;

  @ApiProperty({ description: 'The exact bytes to sign, as the wallet must render them' })
  message: string;

  @ApiProperty({
    description: 'Leads `message` — `STAKE_AUTHORITY_MESSAGE_VERSION`, never the payout-proof tag',
  })
  messageVersion: string;

  @ApiProperty({ description: 'CAIP-10 — the canonical form of the account being claimed' })
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
 * `POST /providers/me/stake-authority` — redeem a signed challenge.
 *
 * Deliberately **only** `challengeId` and `signature`. There is no field here
 * naming the account being proved, and adding one would undo the entire
 * proof: if the request could name the pubkey, provider A could name
 * provider B's, clear the router's stake gate on B's collateral, and — on
 * defecting — have the slash attestation this platform signs point at B's PDA.
 * The account comes off the challenge row, where the platform put it.
 */
export class ProveStakeAuthorityBodyDto {
  @ApiProperty({ description: 'From `POST /providers/me/stake-authority/challenge`' })
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

/**
 * The stored envelope, echoed back. Same four fields as `PayoutProofDto`
 * because it is the same envelope — see `PayoutProof` for why that reuse is
 * deliberate and why `messageVersion` is what says which of the two it is.
 */
export class StakeAuthorityProofDto {
  @ApiProperty()
  challengeId: string;

  @ApiProperty()
  signature: string;

  @ApiProperty()
  messageVersion: string;

  @ApiProperty({ description: 'ISO-8601' })
  provedAt: string;
}

export class ProveStakeAuthorityResponseDto {
  @ApiProperty({
    description: 'CAIP-10 — now proved, and now the account whose stake PDA backs this provider',
  })
  stakeAuthority: string;

  @ApiProperty({ description: 'ISO-8601' })
  provedAt: Date;

  @ApiProperty({ type: StakeAuthorityProofDto })
  proof: StakeAuthorityProofDto;
}
