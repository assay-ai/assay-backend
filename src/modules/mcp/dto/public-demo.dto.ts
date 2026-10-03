import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, Length } from 'class-validator';

import { DemoVerdictState } from '../domain/demo-verdict-state';

/**
 * The wire contract of the public live demo.
 *
 * Money is a **string of minor units** with its own `decimals`, as everywhere
 * else on this API: a JSON number rounds above 2^53, and a demo whose figures
 * were approximate would undercut the one claim the page makes.
 */

export class RunDemoBodyDto {
  @ApiProperty({
    enum: ['pass', 'fail'],
    description:
      'Which binding to call. `fail` is a deliberately broken implementation ' +
      'that returns duplicate ids and is refused payment.',
  })
  @IsIn(['pass', 'fail'])
  side: 'pass' | 'fail';

  @ApiProperty({
    description: 'The search query, in the visitor’s own words.',
    maxLength: 200,
  })
  @IsString()
  @Length(1, 200)
  query: string;
}

export class DemoMoneyDto {
  @ApiProperty({ description: 'Minor units, as a string.' })
  amount: string;

  @ApiProperty()
  asset: string;

  @ApiProperty()
  decimals: number;
}

export class RunDemoResponseDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Poll `GET /public/demo/verdict/:intentId` with this.',
  })
  intentId: string | null;

  @ApiProperty({ enum: ['RESULT', 'ERROR'] })
  status: 'RESULT' | 'ERROR';

  @ApiProperty()
  latencyMs: number;

  @ApiProperty({ description: 'The provider’s response, mapped to the tool’s output schema.' })
  body: unknown;

  @ApiProperty({
    type: DemoMoneyDto,
    description: 'What the tool lists. NOT what was charged — that is decided later.',
  })
  listedPrice: DemoMoneyDto;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description:
      'Set when the broken side could not demonstrate a refusal for this query — ' +
      'fewer than two results means the duplicate check had nothing to compare.',
  })
  inconclusive: string | null;
}

export class DemoVerdictMoneyDto {
  @ApiProperty({ type: DemoMoneyDto })
  listed: DemoMoneyDto;

  @ApiProperty({ type: DemoMoneyDto })
  paid: DemoMoneyDto;

  @ApiProperty({ type: DemoMoneyDto })
  notCharged: DemoMoneyDto;
}

export class DemoVerdictResponseDto {
  @ApiProperty({
    enum: DemoVerdictState,
    description:
      'PENDING — the worker has not judged yet. READY — stages and money below. ' +
      'SETTLED_WITHOUT_JUDGEMENT — refunded synchronously, so no verdict is coming. ' +
      'GAVE_UP — no verdict inside the deadline; said plainly rather than spun on.',
  })
  state: DemoVerdictState;

  @ApiProperty({ nullable: true, type: [Object], description: 'Present only when READY.' })
  stages: unknown[] | null;

  @ApiProperty({ nullable: true, type: DemoVerdictMoneyDto })
  money: DemoVerdictMoneyDto | null;

  @ApiProperty({ nullable: true, type: String })
  reason: string | null;
}
