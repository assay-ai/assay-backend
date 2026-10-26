import { BullModule } from '@nestjs/bullmq';
import { Module, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { LedgerModule } from '@modules/ledger/ledger.module';
import { PaymentModule } from '@modules/payment/payment.module';
import { SlaWindowModule } from '@modules/provider/sla-window.module';

import { VerificationQueue } from './constants/verification-queues.constant';
import {
  VERIFICATION_SAMPLING_CONFIG,
  verificationSamplingConfigFactory,
} from './config/verification-sampling.config';
import {
  EVIDENCE_RETENTION_CONFIG,
  evidenceRetentionConfigFactory,
} from './config/evidence-retention.config';
import { VerificationJudgePublisher } from './publishers/verification-judge.publisher';
import { EvidencePackSealerService } from './services/evidence-pack-sealer.service';
import { EvidencePackService } from './services/evidence-pack.service';
import { EvidenceRetentionService } from './services/evidence-retention.service';
import {
  DEFAULT_KILL_SWITCH_CONFIG,
  KILL_SWITCH_CONFIG,
  KILL_SWITCH_REDIS,
  KILL_SWITCH_SUBSCRIBER,
  KillSwitchConfig,
  RedisPolicyKillSwitchService,
} from './services/redis-policy-kill-switch.service';
import { POLICY_KILL_SWITCH } from './ports/policy-kill-switch.port';
import { DecisionPolicyService } from './services/decision-policy.service';
import { PolicyEvidenceService } from './services/policy-evidence.service';
import { VerificationAggregatorService } from './services/verification-aggregator.service';
import { VerificationSettlementService } from './services/verification-settlement.service';

/**
 * Verification domain — deciding whether an outcome is usable.
 *
 * Scope: schema, deterministic-rule and semantic layers with the verdict
 * vocabulary; receipts; multi-verifier aggregation, versioned policies, the promote gate and the kill switch.
 *
 * The pure core stays in `domain/` and is imported directly rather than
 * injected, exactly as the mapping engine and the classifier are in `tool/`:
 * policy in, response in, verdict out, no clock and no repository. The
 * aggregator is what gives this module providers, because it is the first part of verification that genuinely has state — a policy store, and a
 * kill switch that has to be shared across every process.
 *
 * `SemanticVerificationService` is still deliberately **not**
 * registered: it depends on `SEMANTIC_JUDGE`, no model client implements that
 * port, and providing it without one would turn a missing adapter into a boot
 * failure of the whole API for a class nothing calls. The worker exists, but
 * not the model client — `VerificationSettlementService` drives
 * the sampling *domain* functions directly instead of that service; see
 * `config/verification-sampling.config.ts` for why.
 *
 * The worker is what makes this module import `PaymentModule` and `LedgerModule`:
 * `VerificationSettlementService` is the only thing here with an opinion
 * about money, and it needs `PaymentIntentService` to move an intent off
 * `VERIFYING` and `LedgerService` to repair a hold `resolve()` did not get to
 * finish. `BullModule.registerQueue` follows the project's queue convention
 * (`docs/architecture.md` §"Queue Pattern") — registered and re-exported here in
 * the SHARED module, consumed by `VerificationJudgeProcessor` in
 * `verification-worker.module.ts`, published to from wherever
 * `VerificationSettlementService.enqueue` is reachable (today, only
 * `McpToolCallService`).
 *
 * ## The two Redis clients
 *
 * ioredis puts a client that has issued `SUBSCRIBE` into subscriber mode, where
 * it may not run ordinary commands. The kill switch needs both — it reads the
 * hash and listens for the broadcast — so it gets two connections rather than
 * one. They are its own rather than the shared `REDIS_CACHE_CLIENT` for a
 * second reason: a subscriber that blocks or reconnects must not be able to
 * disturb the cache path, and vice versa. This connection is on the settlement
 * path of every verified call.
 */
const killSwitchRedis = (configService: ConfigService): Redis =>
  new Redis(configService.get<string>('redis.url') as string, {
    password: configService.get<string>('redis.password') || undefined,
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
  });

const providers: Provider[] = [
  // The evidence-pack sealer is a provider of this module rather than the worker's,
  // because `VerificationSettlementService` lives here and the two are one
  // transaction. Whatever process judges, seals.
  EvidencePackSealerService,
  // The reader lives here rather than in the API module because two surfaces
  // need it — the buyer's `/verdicts/:id/evidence` and the provider's
  // `/providers/me/verdicts/:id/evidence`. Two instances would be two places to
  // change the integrity check, and a provider and a buyer disagreeing about
  // one call is worse than either of them seeing nothing.
  EvidencePackService,
  EvidenceRetentionService,
  {
    provide: EVIDENCE_RETENTION_CONFIG,
    inject: [ConfigService],
    useFactory: evidenceRetentionConfigFactory,
  },
  {
    provide: KILL_SWITCH_REDIS,
    inject: [ConfigService],
    useFactory: killSwitchRedis,
  },
  {
    provide: KILL_SWITCH_SUBSCRIBER,
    inject: [ConfigService],
    useFactory: killSwitchRedis,
  },
  {
    provide: KILL_SWITCH_CONFIG,
    inject: [ConfigService],
    useFactory: (configService: ConfigService): KillSwitchConfig => ({
      namespace:
        configService.get<string>('VERIFICATION_KILL_SWITCH_NAMESPACE') ??
        DEFAULT_KILL_SWITCH_CONFIG.namespace,
      pollIntervalMs: Number(
        configService.get<string>('VERIFICATION_KILL_SWITCH_POLL_MS') ??
          DEFAULT_KILL_SWITCH_CONFIG.pollIntervalMs,
      ),
      staleAfterMs: Number(
        configService.get<string>('VERIFICATION_KILL_SWITCH_STALE_MS') ??
          DEFAULT_KILL_SWITCH_CONFIG.staleAfterMs,
      ),
      now: () => Date.now(),
    }),
  },
  RedisPolicyKillSwitchService,
  { provide: POLICY_KILL_SWITCH, useExisting: RedisPolicyKillSwitchService },
  {
    provide: VERIFICATION_SAMPLING_CONFIG,
    inject: [ConfigService],
    useFactory: verificationSamplingConfigFactory,
  },
  DecisionPolicyService,
  // The promotion gate's evidence and the trial labels (operator console).
  PolicyEvidenceService,
  VerificationAggregatorService,
  VerificationJudgePublisher,
  VerificationSettlementService,
];

@Module({
  imports: [
    PaymentModule,
    LedgerModule,
    // `SLA_WINDOW_POSTER`, for `VerificationSettlementService.
    // settle()`. `SlaWindowModule` is a small satellite of the provider domain
    // built for exactly this import, not `ProviderModule` itself — see its own
    // doc comment for why that keeps this edge acyclic.
    SlaWindowModule,
    BullModule.registerQueue({ name: VerificationQueue.JUDGE }),
  ],
  providers,
  exports: [
    EvidencePackService,
    EvidenceRetentionService,
    DecisionPolicyService,
    PolicyEvidenceService,
    VerificationAggregatorService,
    POLICY_KILL_SWITCH,
    VerificationSettlementService,
    VerificationJudgePublisher,
    BullModule,
  ],
})
export class VerificationModule {}
