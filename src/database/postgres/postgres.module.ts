import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { TYPEORM_MODULE_OPTIONS } from '@database/constants/typeorm-module-options';
import { AccountBalanceEntity } from './entities/account-balance.entity';
import { BuyerEscrowEntity } from './entities/buyer-escrow.entity';
import { DepositIntentEntity } from './entities/deposit-intent.entity';
import { EvmGasGrantEntity } from './entities/evm-gas-grant.entity';
import { LedgerEntryEntity } from './entities/ledger-entry.entity';
import { LedgerHoldEntity } from './entities/ledger-hold.entity';
import { PaymentIntentEntity } from './entities/payment-intent.entity';
import { PostEntity } from './entities/post.entity';
import { ReconciliationRunEntity } from './entities/reconciliation-run.entity';
import { StakeSnapshotEntity } from './entities/stake-snapshot.entity';
import { VerificationPolicyEntity } from './entities/verification-policy.entity';
import { EvidenceBodyEntity } from './entities/evidence-body.entity';
import { EvidencePackEntity } from './entities/evidence-pack.entity';
import { VerificationRecordEntity } from './entities/verification-record.entity';
import { SpendPolicyEntity } from './entities/spend-policy.entity';
import { NotificationEntity } from './entities/notification.entity';
import { AuditLogEntryEntity } from './entities/audit-log-entry.entity';
import { AgentCredentialEntity } from './entities/agent-credential.entity';
import { DisputeEntity } from './entities/dispute.entity';
import { VerifierSigningKeyEntity } from './entities/verifier-signing-key.entity';
import { VerifierSigningLogEntryEntity } from './entities/verifier-signing-log-entry.entity';
import { ProviderEntity } from './entities/provider.entity';
import { ProviderPayoutChallengeEntity } from './entities/provider-payout-challenge.entity';
import { ProviderConnectivityCheckEntity } from './entities/provider-connectivity-check.entity';
import { ProviderPayoutEntity } from './entities/provider-payout.entity';
import { AccountBalanceRepository } from './repositories/account-balance.repository';
import { BuyerEscrowRepository } from './repositories/buyer-escrow.repository';
import { DepositIntentRepository } from './repositories/deposit-intent.repository';
import { EvmGasGrantRepository } from './repositories/evm-gas-grant.repository';
import { LedgerEntryRepository } from './repositories/ledger-entry.repository';
import { LedgerHoldRepository } from './repositories/ledger-hold.repository';
import { PaymentIntentRepository } from './repositories/payment-intent.repository';
import { PostRepository } from './repositories/post.repository';
import { ReconciliationRunRepository } from './repositories/reconciliation-run.repository';
import { StakeSnapshotRepository } from './repositories/stake-snapshot.repository';
import { VerificationPolicyRepository } from './repositories/verification-policy.repository';
import { EvidenceBodyRepository } from './repositories/evidence-body.repository';
import { EvidencePackRepository } from './repositories/evidence-pack.repository';
import { VerificationRecordRepository } from './repositories/verification-record.repository';
import { SpendPolicyRepository } from './repositories/spend-policy.repository';
import { NotificationRepository } from './repositories/notification.repository';
import { AuditLogEntryRepository } from './repositories/audit-log-entry.repository';
import { AgentCredentialRepository } from './repositories/agent-credential.repository';
import { DisputeRepository } from './repositories/dispute.repository';
import { VerifierSigningKeyRepository } from './repositories/verifier-signing-key.repository';
import { VerifierSigningLogEntryRepository } from './repositories/verifier-signing-log-entry.repository';
import { ProviderRepository } from './repositories/provider.repository';
import { ProviderPayoutChallengeRepository } from './repositories/provider-payout-challenge.repository';
import { ProviderConnectivityCheckRepository } from './repositories/provider-connectivity-check.repository';
import { ProviderPayoutRepository } from './repositories/provider-payout.repository';
import { BindingCredentialEntity } from './entities/binding-credential.entity';
import { VaultKekCheckEntity } from './entities/vault-kek-check.entity';
import { ToolBindingEntity } from './entities/tool-binding.entity';
import { ToolEntity } from './entities/tool.entity';
import { ToolVersionEntity } from './entities/tool-version.entity';
import { AgentConnectUrlEntity } from './entities/agent-connect-url.entity';
import { ToolsetEntity } from './entities/toolset.entity';
import { ToolsetEntryEntity } from './entities/toolset-entry.entity';
import { BindingVersionEntity } from './entities/binding-version.entity';
import { BindingTestRunEntity } from './entities/binding-test-run.entity';
import { BindingCredentialRepository } from './repositories/binding-credential.repository';
import { VaultKekCheckRepository } from './repositories/vault-kek-check.repository';
import { ToolBindingRepository } from './repositories/tool-binding.repository';
import { ToolRepository } from './repositories/tool.repository';
import { ToolVersionRepository } from './repositories/tool-version.repository';
import { AgentConnectUrlRepository } from './repositories/agent-connect-url.repository';
import { ToolsetEntryRepository, ToolsetRepository } from './repositories/toolset.repository';
import {
  TOOLSET_SHARING_ENTITIES,
  TOOLSET_SHARING_REPOSITORIES,
} from './repositories/toolset-sharing.repository';
import { BindingVersionRepository } from './repositories/binding-version.repository';
import { BindingTestRunRepository } from './repositories/binding-test-run.repository';
import { ProviderStakeGraceEntity } from './entities/provider-stake-grace.entity';
import { ProviderStakeGraceRepository } from './repositories/provider-stake-grace.repository';
import { ProviderChainEnrolmentEntity } from './entities/provider-chain-enrolment.entity';
import { ProviderChainEnrolmentRepository } from './repositories/provider-chain-enrolment.repository';
import { NotificationChannelEntity } from './entities/notification-channel.entity';
import { NotificationPreferenceEntity } from './entities/notification-preference.entity';
import { NotificationDeliveryEntity } from './entities/notification-delivery.entity';
import { ToolCallRecordEntity } from './entities/tool-call-record.entity';
import { NotificationChannelRepository } from './repositories/notification-channel.repository';
import { NotificationPreferenceRepository } from './repositories/notification-preference.repository';
import { NotificationDeliveryRepository } from './repositories/notification-delivery.repository';
import { ToolCallRecordRepository } from './repositories/tool-call-record.repository';
import { SlaWindowEntity } from './entities/sla-window.entity';
import { SlaWindowCallEntity } from './entities/sla-window-call.entity';
import { SlaStrikeEntity } from './entities/sla-strike.entity';
import { SlaWindowRepository } from './repositories/sla-window.repository';
import { SlaWindowCallRepository } from './repositories/sla-window-call.repository';
import { SlaStrikeRepository } from './repositories/sla-strike.repository';
import { OperatorEntity } from './entities/operator.entity';
import { OperatorApprovalEntity } from './entities/operator-approval.entity';
import { AccountBlockEntity } from './entities/account-block.entity';
import { AccountBlockRepository } from './repositories/account-block.repository';
import { EvmBlockedAddressEntity } from './entities/evm-blocked-address.entity';
import { EvmChainStateEntity } from './entities/evm-chain-state.entity';
import { ProviderSlashHoldEntity } from './entities/provider-slash-hold.entity';
import { EvmChainStateRepository } from './repositories/evm-chain-state.repository';
import { ProviderSlashHoldRepository } from './repositories/provider-slash-hold.repository';
import { BindingAttemptEntity } from './entities/binding-attempt.entity';
import { BindingStatsEntity } from './entities/binding-stats.entity';
import { BindingAttemptRepository } from './repositories/binding-attempt.repository';
import { BindingStatsRepository } from './repositories/binding-stats.repository';
import { OperatorRepository } from './repositories/operator.repository';
import { OperatorApprovalRepository } from './repositories/operator-approval.repository';
// Due process for taking money.
import { SlashProposalEntity } from './entities/slash-proposal.entity';
import { ToolRequestEntity } from './entities/tool-request.entity';
import { OrganizationEntity } from './entities/organization.entity';
import { AgentEntity } from './entities/agent.entity';
import { SlashProposalEventEntity } from './entities/slash-proposal-event.entity';
import { SlashProposalPartEntity } from './entities/slash-proposal-part.entity';
import { OverrideLogEntryEntity } from './entities/override-log-entry.entity';
import { FleetSweepEntity } from './entities/fleet-sweep.entity';
import { SlashProposalRepository } from './repositories/slash-proposal.repository';
import { ToolRequestRepository } from './repositories/tool-request.repository';
import { OrganizationRepository } from './repositories/organization.repository';
import { AgentRepository } from './repositories/agent.repository';
import { SlashProposalEventRepository } from './repositories/slash-proposal-event.repository';
import { SlashProposalPartRepository } from './repositories/slash-proposal-part.repository';
import { OverrideLogEntryRepository } from './repositories/override-log-entry.repository';
import { FleetSweepRepository } from './repositories/fleet-sweep.repository';
// The case brief's cross-entity reads; no entity of its own.
import { SlashCaseReadRepository } from './repositories/slash-case-read.repository';
import { PlatformMetricsRepository } from './repositories/platform-metrics.repository';

/** Exported for the per-process boot tests, which stub every repository. */
export const entities = [
  PostEntity,
  LedgerEntryEntity,
  LedgerHoldEntity,
  AccountBalanceEntity,
  BuyerEscrowEntity,
  PaymentIntentEntity,
  DepositIntentEntity,
  EvmGasGrantEntity,
  ReconciliationRunEntity,
  StakeSnapshotEntity,
  VerificationPolicyEntity,
  EvidencePackEntity,
  EvidenceBodyEntity,
  VerificationRecordEntity,
  SpendPolicyEntity,
  NotificationEntity,
  AuditLogEntryEntity,
  AgentCredentialEntity,
  DisputeEntity,
  VerifierSigningKeyEntity,
  VerifierSigningLogEntryEntity,
  ProviderEntity,
  ProviderPayoutChallengeEntity,
  ProviderConnectivityCheckEntity,
  ProviderPayoutEntity,
  ToolEntity,
  ToolVersionEntity,
  ToolsetEntity,
  ToolsetEntryEntity,
  AgentConnectUrlEntity,
  ToolBindingEntity,
  BindingCredentialEntity,
  VaultKekCheckEntity,
  BindingVersionEntity,
  BindingTestRunEntity,
  ProviderStakeGraceEntity,
  ProviderChainEnrolmentEntity,
  NotificationChannelEntity,
  NotificationPreferenceEntity,
  NotificationDeliveryEntity,
  ToolCallRecordEntity,
  SlaWindowEntity,
  SlaWindowCallEntity,
  SlaStrikeEntity,
  SlashProposalEntity,
  ToolRequestEntity,
  SlashProposalEventEntity,
  SlashProposalPartEntity,
  OverrideLogEntryEntity,
  FleetSweepEntity,
  OperatorEntity,
  OperatorApprovalEntity,
  OrganizationEntity,
  AgentEntity,
  AccountBlockEntity,
  EvmChainStateEntity,
  ProviderSlashHoldEntity,
  EvmBlockedAddressEntity,
  BindingAttemptEntity,
  BindingStatsEntity,
  ...TOOLSET_SHARING_ENTITIES,
];
export const repositories = [
  PostRepository,
  LedgerEntryRepository,
  LedgerHoldRepository,
  AccountBalanceRepository,
  BuyerEscrowRepository,
  PaymentIntentRepository,
  DepositIntentRepository,
  EvmGasGrantRepository,
  ReconciliationRunRepository,
  StakeSnapshotRepository,
  VerificationPolicyRepository,
  EvidencePackRepository,
  EvidenceBodyRepository,
  VerificationRecordRepository,
  SpendPolicyRepository,
  NotificationRepository,
  AuditLogEntryRepository,
  AgentCredentialRepository,
  DisputeRepository,
  VerifierSigningKeyRepository,
  VerifierSigningLogEntryRepository,
  ProviderRepository,
  ProviderPayoutChallengeRepository,
  ProviderConnectivityCheckRepository,
  ProviderPayoutRepository,
  ToolRepository,
  ToolVersionRepository,
  ToolsetRepository,
  ToolsetEntryRepository,
  AgentConnectUrlRepository,
  ToolBindingRepository,
  BindingCredentialRepository,
  VaultKekCheckRepository,
  BindingVersionRepository,
  BindingTestRunRepository,
  ProviderStakeGraceRepository,
  ProviderChainEnrolmentRepository,
  NotificationChannelRepository,
  NotificationPreferenceRepository,
  NotificationDeliveryRepository,
  ToolCallRecordRepository,
  SlaWindowRepository,
  SlaWindowCallRepository,
  SlaStrikeRepository,
  SlashProposalRepository,
  ToolRequestRepository,
  SlashProposalEventRepository,
  SlashProposalPartRepository,
  OverrideLogEntryRepository,
  FleetSweepRepository,
  OperatorRepository,
  OperatorApprovalRepository,
  OrganizationRepository,
  AgentRepository,
  AccountBlockRepository,
  EvmChainStateRepository,
  ProviderSlashHoldRepository,
  BindingAttemptRepository,
  BindingStatsRepository,
  SlashCaseReadRepository,
  PlatformMetricsRepository,
  ...TOOLSET_SHARING_REPOSITORIES,
];

/**
 * PostgreSQL Database Module
 * Handles all transactional (OLTP) data
 */
@Global()
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: 'postgres',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService): TypeOrmModuleOptions => {
        const isLogging = configService.get<boolean>('database.logging') || false;

        const config: TypeOrmModuleOptions = {
          type: 'postgres' as const,
          host: configService.get<string>('database.host'),
          port: configService.get<number>('database.port'),
          username: configService.get<string>('database.username'),
          password: configService.get<string>('database.password'),
          database: configService.get<string>('database.database'),
          autoLoadEntities: true,
          entities,
          migrations: [],
          migrationsRun: false,
          synchronize: false,
          logging: isLogging,
          ...(isLogging && {
            logger: TYPEORM_MODULE_OPTIONS.logger,
            maxQueryExecutionTime: TYPEORM_MODULE_OPTIONS.maxQueryExecutionTime,
          }),
        };

        return config;
      },
    }),
    TypeOrmModule.forFeature(entities, 'postgres'),
  ],
  providers: [...repositories],
  exports: [TypeOrmModule, ...repositories],
})
export class PostgresModule {}
