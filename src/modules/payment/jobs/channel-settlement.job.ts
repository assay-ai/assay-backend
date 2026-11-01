import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';

import { ChannelSettlementService } from '../services/channel-settlement.service';

/**
 * The 1-minute channel tick (spec P2 v3.1 §5.4). Scheduler-only and never
 * overlapping, for the reason `VoucherRedemptionJob` gives: one pass over a
 * channel at a time. A settle is bound (`settling_to`) before it is sent, so
 * even a second process would find the channel taken. Idle unless
 * `EVM_CHANNELS_LIVE_CHAINS` names a chain.
 */
@Injectable()
export class ChannelSettlementJob {
  private readonly logger = new Logger(ChannelSettlementJob.name);

  constructor(private readonly settlement: ChannelSettlementService) {}

  @Cron('15 * * * * *', { waitForCompletion: true })
  async tick(): Promise<void> {
    let assets: string[] = [];
    try {
      assets = await this.settlement.assets();
    } catch (error) {
      this.logger.error(`channel assets could not be listed: ${describe(error)}`);
      return;
    }
    for (const asset of assets) {
      await this.settlement.run(asset as never);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
