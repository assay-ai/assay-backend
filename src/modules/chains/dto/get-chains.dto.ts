import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
