import { ApiProperty, getSchemaPath } from '@nestjs/swagger';

import {
  Eip712DomainDto,
  Eip712FieldDto,
} from '@modules/chains/dto/unsigned-chain-transaction.dto';
import { ProofTypedData } from '@modules/chains/ports/payout-proof.types';

/**
 * A provider proof as an EIP-712 request — present on eip155, `null` on Solana.
 *
 * When present, the wallet signs THIS with `eth_signTypedData_v4` and the
 * signature goes back as `0x` hex. `message` alongside it is the verifier's
 * 32-byte digest decoded as text and is not something to show or sign; see
 * `ProofTypedData`.
 */
export class ProofTypedDataDto implements ProofTypedData {
  @ApiProperty({ type: Eip712DomainDto })
  domain!: Eip712DomainDto;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'array', items: { $ref: getSchemaPath(Eip712FieldDto) } },
    example: { PayoutProof: [{ name: 'account', type: 'address' }] },
  })
  types!: Record<string, readonly Eip712FieldDto[]>;

  @ApiProperty({ example: 'PayoutProof' })
  primaryType!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Every value a string; `expiresAt` is a decimal `uint64`.',
  })
  message!: Record<string, string>;
}
