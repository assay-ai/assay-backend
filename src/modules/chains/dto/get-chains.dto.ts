import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChainContractsDto {
  @ApiProperty({ description: 'AssayConfig proxy', example: '0xB33C…C66C' })
  config: string;

  @ApiProperty({ description: 'AssayStake proxy' })
  stake: string;

  @ApiProperty({ description: 'AssayEscrow proxy' })
  escrow: string;

  @ApiProperty({ description: 'The settlement token' })
  asset: string;
}

/**
 * The parameters the settlement contracts hold, as this deployment last read
 * them. The chain is the source of truth: a client renders these and never a
 * copy of its own. Amounts are atomic units of the settlement asset (scale
 * `decimals`). `null` means the value is not known yet (the chain was not
 * read and there is no fallback): show "—", never a guess.
 */
export class ChainParamsDto {
  @ApiProperty({
    enum: ['chain', 'config'],
    description:
      '`chain`: read from the contracts at `readAt`. `config`: the chain was not read yet, ' +
      'and the values with an env fallback carry it.',
  })
  source: 'chain' | 'config';

  @ApiProperty({ nullable: true, type: String, description: 'ISO-8601; when the chain was read' })
  readAt: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: '`params().minimumStake`',
    example: '50000000',
  })
  minimumStake: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: '`params().penaltyAmount`: the most one attestation (one record) can slash',
    example: '1000000',
  })
  penaltyAmount: string | null;

  @ApiProperty({ nullable: true, type: Number, example: 1000 })
  takeRateBps: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Share of a slash paid to agents',
    example: 6000,
  })
  slashAgentBps: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Share of a slash paid to the platform',
    example: 3000,
  })
  slashPlatformBps: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Most of the stake at risk slashed per provider per rolling 24 h',
    example: 1000,
  })
  slashCapBps: number | null;

  @ApiProperty({ nullable: true, type: Number, example: 950400 })
  unbondingPeriodSeconds: number | null;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: '`slashDelaySeconds()`',
    example: 259200,
  })
  slashDelaySeconds: number | null;

  @ApiProperty({
    type: Number,
    description:
      'The delay a provider actually gets before a proposed slash can execute: the larger of ' +
      'the chain delay and the platform policy floor (`SLASH_TIMELOCK_HOURS`)',
    example: 259200,
  })
  effectiveSlashDelaySeconds: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: '`collectHoldSeconds()`: the dispute hold on every paid call',
    example: 3600,
  })
  collectHoldSeconds: number | null;

  @ApiProperty({
    description: 'Contract constant: an escrow withdrawal waits this long',
    example: 10800,
  })
  withdrawDelaySeconds: number;

  @ApiProperty({
    description: 'Contract constant: a tightened limit binds after this long',
    example: 10800,
  })
  tightenDelaySeconds: number;

  @ApiProperty({
    description: 'Contract constant: a voucher stays redeemable this long after expiry',
    example: 7200,
  })
  redeemGraceSeconds: number;

  @ApiProperty({
    description: 'Contract constant: a held payment can be released after this long',
    example: 604800,
  })
  heldTimeoutSeconds: number;

  @ApiProperty({
    description: 'Contract constant: an arbiter dispute times out after this long',
    example: 2592000,
  })
  disputeTimeoutSeconds: number;

  @ApiProperty({ nullable: true, type: Boolean })
  paused: boolean | null;

  @ApiProperty({ nullable: true, type: String })
  arbiter: string | null;
}

export class ChainDto {
  @ApiProperty({ description: 'CAIP-2', example: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1' })
  chainId: string;

  @ApiProperty({ description: 'CAIP-2 namespace', example: 'solana' })
  namespace: string;

  @ApiProperty({ example: 'Solana devnet' })
  displayName: string;

  @ApiProperty({ example: 'https://explorer.solana.com/?cluster=devnet' })
  explorerBaseUrl: string;

  @ApiProperty({
    description: 'CAIP-19. The one asset this chain settles in.',
    example:
      'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1/token:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  })
  settlementAsset: string;

  @ApiProperty({
    description:
      "The settlement asset's ticker, for people — `USDC` on Solana, `USDG` on Robinhood Chain " +
      'testnet. Read from `asset-registry.ts`, which records it beside the scale, and never ' +
      'derived from the CAIP-19 string above: `erc20:0x915E…` says nothing a person can read, ' +
      'and a client that guessed would guess the same word for every chain. This field exists ' +
      'because the frontend had `USDC` written into the funding screens as a literal, which is ' +
      'a false statement on any chain that settles in something else — and the obvious ' +
      'client-side fix, a build-time table of chain id to symbol, is not allowed. If the value ' +
      'is not served, it cannot be shown.',
    example: 'USDC',
  })
  settlementAssetSymbol: string;

  @ApiProperty({
    description: "The settlement asset's scale. 6 on every registered asset.",
    example: 6,
  })
  decimals: number;

  @ApiPropertyOptional({
    description:
      'A PUBLIC JSON-RPC endpoint for this chain, when the deployment names one ' +
      '(`PUBLIC_RPC_URLS`). It is what a browser fills an eip155 transaction from — nonce, gas ' +
      'and fees — before its wallet signs it. Absent means this deployment offers no public ' +
      'endpoint for the chain, and a client that needs one must refuse the chain rather than ' +
      'guess. Never a keyed or private URL: this route is unauthenticated.',
    example: 'https://rpc.testnet.chain.robinhood.com',
  })
  publicRpcUrl?: string;

  @ApiPropertyOptional({
    type: ChainContractsDto,
    description: 'The settlement contracts of this chain. Absent on a chain with none (Solana).',
  })
  contracts?: ChainContractsDto;

  @ApiPropertyOptional({
    type: ChainParamsDto,
    description: 'The on-chain parameters (see `ChainParamsDto`). Absent on a chain with none.',
  })
  params?: ChainParamsDto;
}

export class GetChainsResponseDto {
  @ApiProperty({
    type: [ChainDto],
    description:
      'Exactly the chains ENABLED_CHAINS names, in that order. Never the chains an adapter ' +
      'happens to serve. A build-time copy on the client drifts from this, and the ' +
      'failure is a user shown a chain the API then refuses.',
  })
  chains: ChainDto[];
}
