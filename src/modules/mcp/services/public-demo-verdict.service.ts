import { Inject, Injectable } from '@nestjs/common';

import { PaymentIntentRepository } from '@database/postgres/repositories/payment-intent.repository';
import { VerificationRecordRepository } from '@database/postgres/repositories/verification-record.repository';
import { PaymentIntentStatus } from '@modules/payment/ports/payment.types';

import { DemoVerdictState, decideDemoVerdictState } from '../domain/demo-verdict-state';
import { McpErrors } from '../errors/mcp.errors';
import { PUBLIC_DEMO_CONFIG, PublicDemoConfig } from './public-demo.service';

export interface DemoMoney {
  readonly amount: string;
  readonly asset: string;
  readonly decimals: number;
}

export interface DemoVerdictResult {
  readonly state: DemoVerdictState;
  /** Present only when `state` is `READY`. */
  readonly stages: unknown[] | null;
  readonly money: {
    readonly listed: DemoMoney;
    readonly paid: DemoMoney;
    readonly notCharged: DemoMoney;
  } | null;
  /** Why there will never be a verdict, on `SETTLED_WITHOUT_JUDGEMENT`. */
  readonly reason: string | null;
}

/**
 * Phase two of the public demo: what the checks decided, and what
 * the money did.
 *
 * ## The fence, which is the whole security of this route
 *
 * There is no guard and no session, and the route takes an id from the URL. The
 * naive implementation is therefore a **cross-tenant read of anybody's
 * verification stages** — hand it a real id and it hands back another
 * organization's checks. This exact shape has shipped once already, as an
 * HTTP cache leak that served org A's verdict to org B.
 *
 * So: resolve the intent, and refuse unless its `organizationId` is the demo
 * organization. **404, not 403** — to this route an id outside the demo does
 * not exist, and 403 would confirm that it does. The refusal has its own test,
 * written before the acceptance one.
 *
 * ## Money is here, not in phase one
 *
 * The garbage call reports a charge at the synchronous step and is refunded
 * only once the worker judges it. Reporting money in phase one would make the
 * page print a figure and then correct itself in front of the visitor.
 */
@Injectable()
export class PublicDemoVerdictService {
  constructor(
    private readonly intents: PaymentIntentRepository,
    private readonly records: VerificationRecordRepository,
    @Inject(PUBLIC_DEMO_CONFIG) private readonly config: PublicDemoConfig,
  ) {}

  async read(intentId: string): Promise<DemoVerdictResult> {
    const intent = await this.intents.findByIdAcrossTenants(intentId);

    // One branch for "no such intent" and "not the demo's intent", on purpose.
    // Distinguishing them would tell a caller which ids exist.
    if (!intent || intent.organizationId !== this.config.organizationId) {
      throw McpErrors.demoCallNotFound();
    }

    const record = await this.records.findByIntentId(intent.organizationId, intent.id);
    const judged = Boolean(record && record.verdictStatus);

    const state = decideDemoVerdictState({
      intentStatus: intent.status as PaymentIntentStatus,
      intentReason: intent.statusReason ?? null,
      judged,
      createdAt: intent.createdAt,
      now: new Date(),
    });

    const listed: DemoMoney = {
      amount: intent.priceAmount,
      asset: intent.assetId,
      decimals: intent.decimals,
    };
    const zero: DemoMoney = { amount: '0', asset: intent.assetId, decimals: intent.decimals };
    const settled = intent.status === PaymentIntentStatus.SETTLED;

    return {
      state,
      stages: state === DemoVerdictState.READY ? ((record?.stages as unknown[]) ?? []) : null,
      // Money is final on every state except PENDING — a refund and a
      // settlement are both decided, and only "still judging" has no answer.
      money:
        state === DemoVerdictState.PENDING
          ? null
          : {
              listed,
              paid: settled ? listed : zero,
              notCharged: settled ? zero : listed,
            },
      reason:
        state === DemoVerdictState.SETTLED_WITHOUT_JUDGEMENT
          ? 'The response did not match the tool’s output schema, so the call was refunded ' +
            'immediately and never reached the checks. There is no verdict to wait for.'
          : null,
    };
  }
}
