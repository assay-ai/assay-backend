import { randomUUID } from 'node:crypto';

import { Controller, HttpCode, Post, UseGuards, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';

import { AccountBlockRepository } from '@database/postgres/repositories/account-block.repository';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OrganizationRepository } from '@database/postgres/repositories/organization.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { ProviderRepository } from '@database/postgres/repositories/provider.repository';
import { SlashProposalPartRepository } from '@database/postgres/repositories/slash-proposal-part.repository';
import { SlashProposalRepository } from '@database/postgres/repositories/slash-proposal.repository';
import { AccountErrorCode } from '@modules/account/errors/account.errors';
import { BlockedRole, BlockSubjectKind } from '@modules/blocklist/domain/account-block';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { BlocklistSessionSource } from '@modules/blocklist/services/blocklist-session.source';
import { MCP_SESSION_SOURCE, McpCallerKind, McpSession } from '@modules/mcp/ports/mcp-session.port';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OperatorErrorCode } from '@modules/operator/errors/operator.errors';
import { OperatorSession } from '@modules/operator/ports/operator-session.port';
import { ApprovalQueuedDto } from '@modules/operator/dto/operator-approval.dto';
import type { AccountBlockDto } from '@modules/operator/dto/operator-console.dto';
import { OperatorAccountBlockService } from '@modules/operator/services/operator-account-block.service';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { ProviderSlashRequestsController } from '@modules/slash/controllers/provider-slash-requests.controller';
import { SlashDisputeIntentService } from '@modules/slash/services/slash-dispute-intent.service';
import { SlashRequestLookupService } from '@modules/slash/services/slash-request-lookup.service';
import { SessionAuthGuard } from '@shared/auth';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * The blocklist end to end, against a real Postgres built from every
 * migration and a real Redis: the operator service writing through the real
 * override register, and two `AccountBlocklistService`s standing in for two
 * instances of the API.
 *
 * What is asserted is the property the owner asked for: the instance that
 * wrote the block refuses at once, every other instance within seconds, and the
 * database is the source of truth either way.
 */
const DATABASE = 'assay_account_blocks_test';
const NOTE = 'Agent key leaked in a public repository; reported by the customer.';
const WALLET = 'eip155:84532:0xA271A3407D3302f4b4Fbe469b9188487cedd7d45';

const redisOptions = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 1,
});

/** An ordinary write on the same guard, next to the read-only lookup. */
@UseGuards(SessionAuthGuard)
@Controller('providers/me/slash-requests')
class UnmarkedWriteController {
  @Post('unmarked-write')
  @HttpCode(200)
  write(): { written: true } {
    return { written: true };
  }
}

async function eventually(check: () => boolean, withinMs: number): Promise<number> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > withinMs) throw new Error(`not true within ${withinMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return Date.now() - started;
}

describe('account blocks, against a real database and Redis', () => {
  let dataSource: DataSource;
  let blocks: AccountBlockRepository;
  let channel: string;
  const instances: AccountBlocklistService[] = [];
  let sre: OperatorSession;
  let lead: OperatorSession;
  let adjudicator: OperatorSession;
  const sessions = new Map<string, OperatorSession>();

  /** One API instance's copy of the blocklist. */
  async function instance(pollIntervalMs = 60_000): Promise<AccountBlocklistService> {
    const service = new AccountBlocklistService(
      blocks,
      new Redis(redisOptions()),
      new Redis(redisOptions()),
      { channel, pollIntervalMs },
    );
    await service.onModuleInit();
    instances.push(service);
    return service;
  }

  /**
   * The operator service, with `unblock` driven through the real approvals
   * queue: the lifter's call queues it, and the named second operator approves
   * it with their own session.
   */
  function operatorService(blocklist: AccountBlocklistService) {
    const operators = new OperatorRepository(dataSource);
    const approvals = new OperatorApprovalService(
      new OperatorApprovalRepository(dataSource),
      operators,
      new OperatorService(operators, { get: () => undefined } as never),
    );
    const service = new OperatorAccountBlockService(
      new OverrideLogService(
        dataSource,
        new OverrideLogEntryRepository(dataSource),
        new OperatorApprovalRepository(dataSource),
      ),
      blocks,
      operators,
      blocklist,
      approvals,
      new ProviderRepository(dataSource),
      new OrganizationRepository(dataSource),
    );
    return {
      block: service.block.bind(service),
      list: service.list.bind(service),
      async unblock(
        actor: OperatorSession,
        blockId: string,
        body: { reasonCode: string; note: string },
        approverSubject: string,
      ): Promise<AccountBlockDto> {
        const queued = await service.unblock(actor, blockId, body, null);
        if (!(queued instanceof ApprovalQueuedDto))
          throw new Error('expected the unblock to queue');
        const decided = await approvals.approve(
          queued.approvalId,
          sessions.get(approverSubject) as OperatorSession,
          null,
        );
        return decided.result as AccountBlockDto;
      },
    };
  }

  async function seedOperator(subject: string, roles: OperatorRole[]): Promise<OperatorSession> {
    const id = randomUUID();
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status)
       VALUES ($1, $2, $2, $3, $4::jsonb, 'ACTIVE')`,
      [id, subject, `${subject}@example.test`, JSON.stringify(roles)],
    );
    const session = {
      operatorId: id,
      subject,
      displayName: subject,
      email: `${subject}@example.test`,
      roles,
      authorityLimitMinor: null,
    };
    sessions.set(subject, session);
    return session;
  }

  const register = async (targetId: string) =>
    (await dataSource.query(
      `SELECT code, actor_operator_id, approver_operator_id, approval_mode, organization_id
         FROM override_log_entries WHERE target_id = $1 ORDER BY created_at`,
      [targetId],
    )) as {
      code: string;
      actor_operator_id: string;
      approver_operator_id: string | null;
      approval_mode: string;
      organization_id: string | null;
    }[];

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    blocks = new AccountBlockRepository(dataSource);
    sre = await seedOperator('ops-sre', [OperatorRole.SRE]);
    lead = await seedOperator('ops-adjl', [OperatorRole.ADJL]);
    adjudicator = await seedOperator('ops-adj', [OperatorRole.ADJ]);
  }, 300_000);

  beforeEach(() => {
    // A channel per test, so one test's announcements never reach another's
    // instances.
    channel = `account-blocklist:test:${randomUUID()}`;
  });

  afterEach(async () => {
    await Promise.all(instances.splice(0).map((service) => service.onModuleDestroy()));
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  it('blocks at once on the writer and within moments on another instance, then lifts the same way', async () => {
    const writer = await instance();
    const other = await instance();
    const ops = operatorService(writer);
    const org = randomUUID();

    const block = await ops.block(
      sre,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'FRAUD', note: NOTE },
      null,
    );

    // The writer: no window at all.
    expect(writer.organizationBlock(org)?.blockId).toBe(block.id);
    // Another instance: by pub/sub, long before its 60s poll.
    const seenIn = await eventually(() => other.organizationBlock(org) !== null, 5_000);
    expect(seenIn).toBeLessThan(5_000);

    expect(await register(block.id)).toEqual([
      {
        code: 'A-9',
        actor_operator_id: sre.operatorId,
        approver_operator_id: null,
        approval_mode: 'SINGLE',
        organization_id: org,
      },
    ]);

    const lifted = await ops.unblock(
      sre,
      block.id,
      { reasonCode: 'CLEARED', note: NOTE },
      'ops-adjl',
    );
    expect(lifted).toMatchObject({ active: false, unblockApprovedBy: 'ops-adjl' });
    expect(writer.organizationBlock(org)).toBeNull();
    await eventually(() => other.organizationBlock(org) === null, 5_000);

    expect((await register(block.id)).map((entry) => entry.code)).toEqual(['A-9', 'A-10']);
    expect((await register(block.id))[1]).toMatchObject({
      approver_operator_id: lead.operatorId,
      approval_mode: 'TWO_PERSON',
    });
  });

  it('reaches an instance that missed the announcement on its next poll', async () => {
    const writer = await instance();
    const ops = operatorService(writer);
    // Subscribed to another channel, so it can only learn by polling.
    channel = `account-blocklist:test:${randomUUID()}`;
    const deaf = await instance(200);

    const block = await ops.block(
      sre,
      {
        subjectKind: BlockSubjectKind.WALLET,
        subject: WALLET,
        reasonCode: 'LEAKED_KEY',
        note: NOTE,
      },
      null,
    );

    // Matched on another EVM chain, as enforcement matches it.
    await eventually(
      () => deaf.walletBlock('eip155:8453:0xa271a3407d3302f4b4fbe469b9188487cedd7d45') !== null,
      2_000,
    );
    expect((await register(block.id))[0].organization_id).toBeNull();

    await ops.unblock(sre, block.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
  });

  it('loads standing blocks from the database at boot, whoever wrote them', async () => {
    const writer = await instance();
    const org = randomUUID();
    const block = await operatorService(writer).block(
      lead,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'X', note: NOTE },
      null,
    );

    const booted = await instance();
    expect(booted.organizationBlock(org)?.blockId).toBe(block.id);
    expect(() =>
      booted.assertNotBlocked([
        { role: BlockedRole.PROVIDER, kind: BlockSubjectKind.ORGANIZATION, subject: org },
      ]),
    ).toThrow(expect.objectContaining({ errorCode: AccountErrorCode.ACCOUNT_BLOCKED }));

    await operatorService(writer).unblock(
      sre,
      block.id,
      { reasonCode: 'X', note: NOTE },
      'ops-adjl',
    );
  });

  it('refuses a second standing block of one key, at the database too', async () => {
    const writer = await instance();
    const ops = operatorService(writer);
    const org = randomUUID();
    const first = await ops.block(
      sre,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'X', note: NOTE },
      null,
    );

    await expect(
      ops.block(
        sre,
        { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'X', note: NOTE },
        null,
      ),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_BLOCK_ALREADY_ACTIVE });

    // Past the service's own check: the partial unique index.
    await expect(
      dataSource.query(
        `INSERT INTO account_blocks (subject_kind, subject, subject_key, reason_code, note, blocked_by)
         VALUES ('ORGANIZATION', $1, $1, 'X', $2, $3)`,
        [org, NOTE, sre.operatorId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Once lifted, the subject can be blocked again — a new row.
    await ops.unblock(sre, first.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
    const second = await ops.block(
      sre,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'X', note: NOTE },
      null,
    );
    expect(second.id).not.toBe(first.id);
    await ops.unblock(sre, second.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
  });

  it('refuses a lifting a lead did not check, and leaves block, register and cache as they were', async () => {
    const writer = await instance();
    const ops = operatorService(writer);
    const org = randomUUID();
    const block = await ops.block(
      sre,
      { subjectKind: BlockSubjectKind.ORGANIZATION, subject: org, reasonCode: 'X', note: NOTE },
      null,
    );

    await expect(
      ops.unblock(sre, block.id, { reasonCode: 'X', note: NOTE }, 'ops-adj'),
    ).rejects.toMatchObject({ errorCode: OperatorErrorCode.OPERATOR_APPROVER_ROLE_REQUIRED });

    const [row] = (await dataSource.query(`SELECT unblocked_at FROM account_blocks WHERE id = $1`, [
      block.id,
    ])) as { unblocked_at: Date | null }[];
    expect(row.unblocked_at).toBeNull();
    expect((await register(block.id)).map((entry) => entry.code)).toEqual(['A-9']);
    expect(writer.organizationBlock(org)).not.toBeNull();
    void adjudicator;

    await ops.unblock(sre, block.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
  });

  it('refuses, at the database, a lifting without a second person or approved by the lifter', async () => {
    const org = randomUUID();
    const [{ id }] = (await dataSource.query(
      `INSERT INTO account_blocks (subject_kind, subject, subject_key, reason_code, note, blocked_by)
       VALUES ('ORGANIZATION', $1, $1, 'X', $2, $3) RETURNING id`,
      [org, NOTE, sre.operatorId],
    )) as { id: string }[];

    await expect(
      dataSource.query(
        `UPDATE account_blocks SET unblocked_at = now(), unblocked_by = $2, unblock_note = $3
          WHERE id = $1`,
        [id, sre.operatorId, NOTE],
      ),
    ).rejects.toMatchObject({ constraint: 'chk_account_blocks_unblock_complete' });
    await expect(
      dataSource.query(
        `UPDATE account_blocks SET unblocked_at = now(), unblocked_by = $2,
                unblock_approved_by = $2, unblock_note = $3
          WHERE id = $1`,
        [id, sre.operatorId, NOTE],
      ),
    ).rejects.toMatchObject({ constraint: 'chk_account_blocks_unblock_two_person' });
  });

  it('lists blocks newest first and filters by subject, kind and standing', async () => {
    const writer = await instance();
    const ops = operatorService(writer);
    const wallet = 'eip155:84532:0x976ea74026e726554db657fa54763abd0c3a0aa9';
    const block = await ops.block(
      sre,
      {
        subjectKind: BlockSubjectKind.WALLET,
        subject: wallet,
        reasonCode: 'LEAKED_KEY',
        note: NOTE,
      },
      null,
    );

    const bySubject = await ops.list({
      subject: 'eip155:1:0x976EA74026E726554DB657FA54763ABD0C3A0AA9',
      limit: 25,
    } as never);
    expect(bySubject.items.map((item) => item.id)).toEqual([block.id]);

    const active = await ops.list({
      subjectKind: BlockSubjectKind.WALLET,
      active: true,
      limit: 25,
    } as never);
    expect(active.items.map((item) => item.id)).toContain(block.id);
    expect(active.items.every((item) => item.active)).toBe(true);

    await ops.unblock(sre, block.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
    const lifted = await ops.list({ active: false, limit: 100 } as never);
    expect(lifted.items.map((item) => item.id)).toContain(block.id);
    const times = lifted.items.map((item) => new Date(item.blockedAt).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
  it('lets a blocked person POST the read-only penalties lookup over HTTP, and nothing else', async () => {
    const writer = await instance();
    const org = randomUUID();
    const sessionFor = (callerKind: McpCallerKind): McpSession => ({
      credentialId: `cred-${callerKind}`,
      organizationId: org,
      agentId: 'agent-1',
      agentAccount: WALLET as never,
      chainId: 'eip155:84532' as never,
      label: null,
      callerKind,
      paymentsAllowed: true,
      delegateAccount: null,
    });
    const tokenKinds: Record<string, McpCallerKind> = {
      person: McpCallerKind.HUMAN,
      machine: McpCallerKind.AGENT,
    };
    const inner = {
      resolve: async (token: string | null) => {
        const kind = token ? tokenKinds[token] : undefined;
        if (!kind) throw new Error('unknown bearer token in test stub');
        return sessionFor(kind);
      },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [ProviderSlashRequestsController, UnmarkedWriteController],
      providers: [
        SessionAuthGuard,
        { provide: MCP_SESSION_SOURCE, useValue: new BlocklistSessionSource(inner, writer) },
        {
          provide: SlashRequestLookupService,
          useValue: new SlashRequestLookupService(
            new SlashProposalRepository(dataSource),
            new SlashProposalPartRepository(dataSource),
          ),
        },
        // The dispute intent (D-19): a stand-in that builds, so the route's
        // blocklist marking is what is under test.
        {
          provide: SlashDisputeIntentService,
          useValue: {
            providerDispute: async (_org: string, chainId: string, requestIds: string[]) => ({
              chainId,
              to: '0x7242F853db478A28Ae76Ace808212d4B68aa73e7',
              data: '0x',
              value: '0',
              signer: '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45',
              signerRole: 'PROVIDER',
              functionName: 'disputeSlashBatch',
              requestIds,
            }),
          },
        },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    try {
      const lookup = (token: string) =>
        request(app.getHttpServer())
          .post('/providers/me/slash-requests/lookup')
          .set('Authorization', `Bearer ${token}`)
          .send({ requestIds: [`0x${'ab'.repeat(32)}`] });
      const unmarked = (token: string) =>
        request(app.getHttpServer())
          .post('/providers/me/slash-requests/unmarked-write')
          .set('Authorization', `Bearer ${token}`)
          .send({});

      // Not blocked: both answer.
      expect((await lookup('person')).status).toBe(200);
      expect((await unmarked('person')).status).toBe(200);

      const ops = operatorService(writer);
      const block = await ops.block(
        sre,
        {
          subjectKind: BlockSubjectKind.ORGANIZATION,
          subject: org,
          reasonCode: 'FRAUD',
          note: NOTE,
        },
        null,
      );

      // Blocked person: the read-only POST answers, the ordinary write is refused.
      const read = await lookup('person');
      expect(read.status).toBe(200);
      // …and so does the on-chain dispute intent: the chain lets a blocked
      // provider dispute, and building a transaction writes nothing here.
      const dispute = await request(app.getHttpServer())
        .post('/providers/me/slash-requests/dispute-intent')
        .set('Authorization', 'Bearer person')
        .send({ chainId: 'eip155:46630', requestIds: [`0x${'ab'.repeat(32)}`] });
      expect(dispute.status).toBe(200);
      expect(JSON.stringify(dispute.body)).toContain('disputeSlashBatch');
      expect(JSON.stringify(read.body)).toContain('matches');
      const refused = await unmarked('person');
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).toContain('AUTH_ORGANIZATION_SUSPENDED');

      // Blocked machine credential: refused outright, the read-only POST too.
      const machine = await lookup('machine');
      expect(machine.status).toBe(403);
      expect(JSON.stringify(machine.body)).toContain('AUTH_ORGANIZATION_SUSPENDED');

      await ops.unblock(sre, block.id, { reasonCode: 'X', note: NOTE }, 'ops-adjl');
      expect((await lookup('person')).status).toBe(200);
      expect((await unmarked('person')).status).toBe(200);
      // Lifted, the machine credential is past the blocklist, and refused only
      // because provider account controls take a signed-in person (2bba278).
      const unblockedMachine = await lookup('machine');
      expect(unblockedMachine.status).toBe(403);
      expect(JSON.stringify(unblockedMachine.body)).toContain('AUTH_HUMAN_SESSION_REQUIRED');
    } finally {
      await app.close();
    }
  });
});
