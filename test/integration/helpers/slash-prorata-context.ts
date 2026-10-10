import { join } from 'node:path';

import { Client } from 'pg';
import { DataSource } from 'typeorm';

import { FleetSweepRepository } from '@database/postgres/repositories/fleet-sweep.repository';
import { ProviderChainEnrolmentRepository } from '@database/postgres/repositories/provider-chain-enrolment.repository';
import { SlaWindowCallRepository } from '@database/postgres/repositories/sla-window-call.repository';
import { SlashProposalEventRepository } from '@database/postgres/repositories/slash-proposal-event.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { ProRataSlashConfig, SlashConfig } from '@modules/slash/constants/slash.constants';
import { SlashCapsReaderPort } from '@modules/slash/ports/slash-caps-reader.port';
import { SlashExecutorPort } from '@modules/slash/ports/slash-executor.port';
import { SlashExecutionService } from '@modules/slash/services/slash-execution.service';
import { SlashPartsService } from '@modules/slash/services/slash-parts.service';
import { SlashProposalService } from '@modules/slash/services/slash-proposal.service';

import { testConnectionOptions } from './test-database';

const HOUR = 3_600_000;

/**
 * A database built from EVERY migration on disk, dropped and recreated first —
 * the same rule as `column-widths.integration.spec.ts`: a reused database
 * would assert a schema built by migrations that may no longer exist.
 */
export async function freshMigratedDatabase(database: string): Promise<DataSource> {
  const connection = testConnectionOptions();
  const admin = new Client({
    host: connection.host,
    port: connection.port,
    user: connection.username,
    password: connection.password,
    database: 'postgres',
  });
  await admin.connect();
  try {
    const quoted = `"${database.replace(/"/g, '""')}"`;
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await admin.end();
  }
  return openDatabase(database, true);
}

/** Open (and optionally migrate) an existing database with every entity. */
export async function openDatabase(database: string, migrate = false): Promise<DataSource> {
  const root = join(__dirname, '../../../src/database/postgres');
  const dataSource = new DataSource({
    type: 'postgres',
    ...testConnectionOptions(),
    database,
    entities: [join(root, 'entities/*.entity.ts')],
    migrations: [join(root, 'migrations/*.ts')],
    synchronize: false,
    migrationsRun: false,
  });
  await dataSource.initialize();
  if (migrate) await dataSource.runMigrations({ transaction: 'each' });
  return dataSource;
}

export const TEST_SLASH_CONFIG: SlashConfig = {
  timelockMs: 72 * HOUR,
  responseWindowMs: 48 * HOUR,
  platformDecisionWindowMs: 23 * HOUR,
  executionGuardMs: 1 * HOUR,
  deMinimisMinor: '0',
  secondSignatureThresholdMinor: '2500000',
  sweepBatchSize: 100,
  assetDecimals: 6,
};

export interface ProRataSlashServices {
  readonly execution: SlashExecutionService;
  readonly lifecycle: SlashProposalService;
  readonly parts: SlashPartsService;
  readonly proposals: SlashProposalRepository;
  readonly partsRepository: SlashProposalPartRepository;
  /** Every call `SlashExecutionService` made to the ledger distributor. */
  readonly ledgerDistributions: unknown[];
}

/**
 * The real slash services over a real database, with the chain behind
 * `executor`. Only the notification sink, the override log and the ledger
 * distributor are stand-ins — the first two are not on the path under test,
 * and the third is recorded so a test can assert it is NEVER called for an
 * on-chain pro-rata case.
 */
export function buildProRataSlashServices(
  dataSource: DataSource,
  executor: SlashExecutorPort,
  caps: SlashCapsReaderPort,
  prorata: ProRataSlashConfig = {
    dustReportBelowMinor: 0n,
    stragglerMaxAttempts: 6,
    stragglerDeadlineMs: 24 * HOUR,
  },
): ProRataSlashServices {
  const proposals = new SlashProposalRepository(dataSource);
  const events = new SlashProposalEventRepository(dataSource);
  const partsRepository = new SlashProposalPartRepository(dataSource);
  const windowCalls = new SlaWindowCallRepository(dataSource);
  const notifications = { notify: async () => undefined } as never;
  const lifecycle = new SlashProposalService(proposals, events, notifications, TEST_SLASH_CONFIG);
  const parts = new SlashPartsService(partsRepository, windowCalls, executor, prorata, caps);
  const ledgerDistributions: unknown[] = [];
  const compensation = {
    distribute: async (request: unknown) => {
      ledgerDistributions.push(request);
      return 0;
    },
  } as never;
  const execution = new SlashExecutionService(
    proposals,
    new ProviderChainEnrolmentRepository(dataSource),
    new FleetSweepRepository(dataSource),
    lifecycle,
    {} as never,
    notifications,
    TEST_SLASH_CONFIG,
    executor,
    null,
    compensation,
    null,
    parts,
  );
  return { execution, lifecycle, parts, proposals, partsRepository, ledgerDistributions };
}
