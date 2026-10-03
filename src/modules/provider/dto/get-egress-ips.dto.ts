import { ApiProperty } from '@nestjs/swagger';

/**
 * `GET /providers/egress-ips` — the allowlist to publish ("Add them to your
 * allowlist, then run the check here rather than finding out after you go
 * live.").
 *
 * Empty is a real, non-error state — see `egress-ips.ts`'s class comment for
 * why an unset list means "not behind fixed egress addresses" rather than a
 * misconfiguration.
 */
export class GetEgressIpsResponseDto {
  @ApiProperty({
    type: [String],
    example: ['203.0.113.10', '203.0.113.11', '203.0.113.12'],
  })
  egressIps: string[];
}
