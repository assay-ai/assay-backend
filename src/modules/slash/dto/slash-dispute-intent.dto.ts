import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, Matches } from 'class-validator';

/** `MAX_SLASH_BATCH` in assay-evm's `Constants.sol` (D-19). */
export const SLASH_DISPUTE_BATCH_MAX = 64;

/** `POST /providers/me/slash-requests/dispute-intent`. */
export class DisputeSlashRequestsBodyDto {
  @ApiProperty({ example: 'eip155:46630', description: 'The CAIP-2 chain the records are on' })
  @IsString()
  @Matches(/^eip155:[0-9]+$/, { message: 'chainId must be an eip155 CAIP-2 chain id' })
  chainId: string;

  @ApiProperty({
    isArray: true,
    type: String,
    minItems: 1,
    maxItems: SLASH_DISPUTE_BATCH_MAX,
    description: 'On-chain slash request ids to dispute: `0x` + 32 bytes of hex, any case',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SLASH_DISPUTE_BATCH_MAX)
  @IsString({ each: true })
  @Matches(/^0x[0-9a-fA-F]{64}$/, { each: true, message: 'each requestId must be 0x + 64 hex' })
  requestIds: string[];
}

/** One unsigned contract call. Send `{ to, data, value }` from `signer`; nothing else may. */
export class SlashContractCallDto {
  @ApiProperty({ example: 'eip155:46630' })
  chainId: string;

  @ApiProperty({ description: 'The contract (proxy) to send to' })
  to: string;

  @ApiProperty({ description: 'ABI-encoded calldata, 0x-hex. Unsigned.' })
  data: string;

  @ApiProperty({ example: '0' })
  value: string;

  @ApiProperty({ description: 'The only account the contract accepts this call from' })
  signer: string;

  @ApiProperty({ enum: ['PROVIDER', 'ARBITER', 'ADMIN'] })
  signerRole: string;

  @ApiProperty({
    enum: ['disputeSlashBatch', 'upholdSlashBatch', 'cancelSlashBatch', 'setBlocked'],
  })
  functionName: string;

  @ApiProperty({
    isArray: true,
    type: String,
    description: 'The request ids carried, `0x` + lower-case hex, in calldata order',
  })
  requestIds: string[];
}
