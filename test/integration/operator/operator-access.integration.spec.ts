import { randomUUID } from 'node:crypto';

import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import Redis from 'ioredis';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { generatePrivateKey, privateKeyToAccount, PrivateKeyAccount } from 'viem/accounts';

import { AccountBlockRepository } from '@database/postgres/repositories/account-block.repository';
import { OperatorApprovalRepository } from '@database/postgres/repositories/operator-approval.repository';
import { OperatorRepository } from '@database/postgres/repositories/operator.repository';
import { OverrideLogEntryRepository } from '@database/postgres/repositories/override-log-entry.repository';
import { AccountBlocklistService } from '@modules/blocklist/services/account-blocklist.service';
import { OperatorSessionStore } from '@modules/operator/auth/operator-session.store';
import { OPERATOR_SIGN_IN_CONFIG } from '@modules/operator/auth/operator-sign-in.config';
import { OperatorSignInService } from '@modules/operator/auth/operator-sign-in.service';
import { WalletOperatorSessionSource } from '@modules/operator/auth/wallet-operator-session.source';
import { OperatorApprovalsController } from '@modules/operator/controllers/operator-approvals.controller';
import { OperatorBlocksController } from '@modules/operator/controllers/operator-blocks.controller';
import { OperatorOperatorsController } from '@modules/operator/controllers/operator-operators.controller';
import { OperatorSignInController } from '@modules/operator/controllers/operator-sign-in.controller';
import { OperatorRole } from '@modules/operator/domain/override-register';
import { OPERATOR_SESSION_SOURCE } from '@modules/operator/ports/operator-session.port';
import { OperatorAccountBlockService } from '@modules/operator/services/operator-account-block.service';
import { OperatorApprovalService } from '@modules/operator/services/operator-approval.service';
import { OperatorAuthThrottle } from '@modules/operator/services/operator-auth-throttle.service';
import { OperatorDirectoryService } from '@modules/operator/services/operator-directory.service';
import { OperatorService } from '@modules/operator/services/operator.service';
import { OverrideLogService } from '@modules/operator/services/override-log.service';
import { REDIS_CACHE_CLIENT } from '@shared/cache/redis-cache/redis-cache.provider';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import { freshMigratedDatabase } from '../helpers/slash-prorata-context';

/**
 * Operator access end to end, over HTTP, against a real Postgres and Redis:
 * wallet sign-in, the session on every request, the operator directory, and
 * the approvals queue — with the real guards, the real register and the real
 * session store. Only the blocklist's broadcast is stubbed.
 */
const DATABASE = 'assay_operator_access_test';
const DOMAIN = 'console.goassay.test';
const NOTE = 'Provisioned for the on-call rotation this quarter.';

const redisOptions = () => ({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  // A database of its own, flushed between tests, so the throttle of one test
  // never blocks the next.
  db: 7,
  maxRetriesPerRequest: 1,
});

describe('operator access, over HTTP, against a real database and Redis', () => {
  let dataSource: DataSource;
  let redis: Redis;
  let app: INestApplication;

  beforeAll(async () => {
    dataSource = await freshMigratedDatabase(DATABASE);
    redis = new Redis(redisOptions());

    const moduleRef = await Test.createTestingModule({
      controllers: [
        OperatorSignInController,
        OperatorOperatorsController,
        OperatorApprovalsController,
        OperatorBlocksController,
      ],
      providers: [
        { provide: getDataSourceToken('postgres'), useValue: dataSource },
        { provide: REDIS_CACHE_CLIENT, useValue: redis },
        { provide: ConfigService, useValue: { get: () => undefined } },
        {
          provide: OPERATOR_SIGN_IN_CONFIG,
          useValue: {
            domain: DOMAIN,
            uri: `https://${DOMAIN}/operator`,
            chainId: 46630,
            sessionTtlSeconds: 3600,
          },
        },
        { provide: AccountBlocklistService, useValue: { applied: async () => undefined } },
        OperatorRepository,
        OperatorApprovalRepository,
        OverrideLogEntryRepository,
        AccountBlockRepository,
        OperatorService,
        OperatorSessionStore,
        OperatorAuthThrottle,
        OperatorSignInService,
        WalletOperatorSessionSource,
        { provide: OPERATOR_SESSION_SOURCE, useExisting: WalletOperatorSessionSource },
        OverrideLogService,
        OperatorApprovalService,
        OperatorDirectoryService,
        OperatorAccountBlockService,
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor(app.get(Reflector)));
    await app.init();
  }, 300_000);

  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  const http = () => request(app.getHttpServer());

  async function seedOperator(
    roles: OperatorRole[],
    account: PrivateKeyAccount = privateKeyToAccount(generatePrivateKey()),
  ) {
    const id = randomUUID();
    const subject = `op-${id.slice(0, 8)}@`;
    await dataSource.query(
      `INSERT INTO operators (id, subject, display_name, email, roles, status, wallet_address)
       VALUES ($1, $2, $2, $3, $4::jsonb, 'ACTIVE', $5)`,
      [id, subject, `${id}@example.test`, JSON.stringify(roles), account.address.toLowerCase()],
    );
    return { id, subject, account };
  }

  async function signIn(account: PrivateKeyAccount): Promise<string> {
    const challenge = await http()
      .post('/operator/auth/challenge')
      .send({ address: account.address })
      .expect(200);
    const { message } = challenge.body.data;
    const verified = await http()
      .post('/operator/auth/verify')
      .send({ message, signature: await account.signMessage({ message }) })
      .expect(200);
    return verified.body.data.token as string;
  }

  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  describe('sign-in', () => {
    it('signs an operator in, and the session reaches an operator route', async () => {
      const { account } = await seedOperator([OperatorRole.SRE]);
      const token = await signIn(account);

      const list = await http().get('/operator/operators').set(bearer(token)).expect(200);
      expect(list.body.data.items.map((o: { walletAddress: string }) => o.walletAddress)).toContain(
        account.address.toLowerCase(),
      );
    });

    it('answers 403 OPERATOR_NOT_AUTHORIZED to a wallet that is no operator', async () => {
      const stranger = privateKeyToAccount(generatePrivateKey());
      const { message } = (
        await http().post('/operator/auth/challenge').send({ address: stranger.address })
      ).body.data;

      const refused = await http()
        .post('/operator/auth/verify')
        .send({ message, signature: await stranger.signMessage({ message }) })
        .expect(403);
      expect(refused.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    });

    it('answers 401 to a forged or replayed signature, and to no session at all', async () => {
      const { account } = await seedOperator([OperatorRole.SRE]);
      const { message } = (
        await http().post('/operator/auth/challenge').send({ address: account.address })
      ).body.data;
      const forged = await privateKeyToAccount(generatePrivateKey()).signMessage({ message });

      const refused = await http()
        .post('/operator/auth/verify')
        .send({ message, signature: forged })
        .expect(401);
      expect(refused.body.error.code).toBe('OPERATOR_CREDENTIAL_INVALID');
      // The nonce was spent by the failed attempt.
      await http()
        .post('/operator/auth/verify')
        .send({ message, signature: await account.signMessage({ message }) })
        .expect(401);

      await http().get('/operator/operators').expect(401);
      await http().get('/operator/operators').set(bearer('not-a-session')).expect(401);
    });

    it('refuses a suspended operator at sign-in', async () => {
      const { id, account } = await seedOperator([OperatorRole.SRE]);
      await dataSource.query(
        `UPDATE operators SET status = 'SUSPENDED', suspended_at = now() WHERE id = $1`,
        [id],
      );
      const { message } = (
        await http().post('/operator/auth/challenge').send({ address: account.address })
      ).body.data;
      const refused = await http()
        .post('/operator/auth/verify')
        .send({ message, signature: await account.signMessage({ message }) })
        .expect(403);
      expect(refused.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    });

    it('logs out: the session stops working at once', async () => {
      const { account } = await seedOperator([OperatorRole.SRE]);
      const token = await signIn(account);

      await http().post('/operator/auth/logout').set(bearer(token)).expect(204);
      await http().get('/operator/operators').set(bearer(token)).expect(401);
    });

    it('rate-limits an address after ten failed verifications', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await http()
          .post('/operator/auth/verify')
          .send({ message: 'not a sign-in message', signature: '0x00' })
          .expect(401);
      }
      const limited = await http()
        .post('/operator/auth/verify')
        .send({ message: 'not a sign-in message', signature: '0x00' })
        .expect(429);
      expect(limited.body.error.code).toBe('OPERATOR_AUTH_RATE_LIMITED');
    });
  });

  describe('the operator directory', () => {
    it('adds an operator only once a second OPS_ADMIN approves, and they can then sign in', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const second = await seedOperator([OperatorRole.OPS_ADMIN]);
      const newcomer = privateKeyToAccount(generatePrivateKey());
      const adminToken = await signIn(admin.account);

      const queued = await http()
        .post('/operator/operators')
        .set(bearer(adminToken))
        .send({
          walletAddress: newcomer.address,
          subject: `new-${randomUUID().slice(0, 6)}@`,
          roles: [OperatorRole.ADJ],
          authorityLimitMinor: '5000000',
          reasonCode: 'ONBOARDING',
          note: NOTE,
        })
        .expect(202);
      expect(queued.body.data).toMatchObject({ status: 'PENDING', action: 'operator.add' });
      expect(queued.body.statusCode).toBe(202);
      const { approvalId } = queued.body.data;

      // Not an operator yet.
      const { message } = (
        await http().post('/operator/auth/challenge').send({ address: newcomer.address })
      ).body.data;
      await http()
        .post('/operator/auth/verify')
        .send({ message, signature: await newcomer.signMessage({ message }) })
        .expect(403);

      // The requester cannot approve it themselves.
      const self = await http()
        .post(`/operator/approvals/${approvalId}/approve`)
        .set(bearer(adminToken))
        .expect(409);
      expect(self.body.error.code).toBe('OPERATOR_SELF_APPROVAL_REFUSED');

      const pending = await http()
        .get('/operator/approvals?status=PENDING')
        .set(bearer(adminToken))
        .expect(200);
      expect(pending.body.data.items.map((a: { id: string }) => a.id)).toContain(approvalId);

      const approved = await http()
        .post(`/operator/approvals/${approvalId}/approve`)
        .set(bearer(await signIn(second.account)))
        .expect(200);
      expect(approved.body.data.approval.status).toBe('APPROVED');
      expect(approved.body.data.result).toMatchObject({
        walletAddress: newcomer.address.toLowerCase(),
        roles: [OperatorRole.ADJ],
        status: 'ACTIVE',
      });

      await signIn(newcomer);
      const entry = await dataSource.query(
        `SELECT actor_operator_id, approver_operator_id, approval_mode FROM override_log_entries
          WHERE code = 'A-12' AND target_id = $1`,
        [approved.body.data.result.id],
      );
      expect(entry).toEqual([
        {
          actor_operator_id: admin.id,
          approver_operator_id: second.id,
          approval_mode: 'TWO_PERSON',
        },
      ]);
    });

    it('refuses an approver who does not hold OPS_ADMIN', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const lead = await seedOperator([OperatorRole.ADJL]);
      const queued = await http()
        .post('/operator/operators')
        .set(bearer(await signIn(admin.account)))
        .send({
          walletAddress: privateKeyToAccount(generatePrivateKey()).address,
          subject: `new-${randomUUID().slice(0, 6)}@`,
          roles: [OperatorRole.SRE],
          reasonCode: 'ONBOARDING',
          note: NOTE,
        })
        .expect(202);

      const refused = await http()
        .post(`/operator/approvals/${queued.body.data.approvalId}/approve`)
        .set(bearer(await signIn(lead.account)))
        .expect(403);
      expect(refused.body.error.code).toBe('OPERATOR_APPROVER_ROLE_REQUIRED');
    });

    it('lowers roles at once, single-person, and raising them waits for approval', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const target = await seedOperator([OperatorRole.ADJ, OperatorRole.SRE]);
      const token = await signIn(admin.account);

      const lowered = await http()
        .patch(`/operator/operators/${target.id}`)
        .set(bearer(token))
        .send({ roles: [OperatorRole.SRE], reasonCode: 'ROTATION', note: NOTE })
        .expect(200);
      expect(lowered.body.data.roles).toEqual([OperatorRole.SRE]);

      const raised = await http()
        .patch(`/operator/operators/${target.id}`)
        .set(bearer(token))
        .send({ roles: [OperatorRole.SRE, OperatorRole.ADJL], reasonCode: 'ROTATION', note: NOTE })
        .expect(202);
      expect(raised.body.data.action).toBe('operator.change');
      const [row] = await dataSource.query(`SELECT roles FROM operators WHERE id = $1`, [
        target.id,
      ]);
      expect(row.roles).toEqual([OperatorRole.SRE]);

      const second = await seedOperator([OperatorRole.OPS_ADMIN]);
      await http()
        .post(`/operator/approvals/${raised.body.data.approvalId}/approve`)
        .set(bearer(await signIn(second.account)))
        .expect(200);
      const [after] = await dataSource.query(`SELECT roles FROM operators WHERE id = $1`, [
        target.id,
      ]);
      expect(after.roles).toEqual([OperatorRole.SRE, OperatorRole.ADJL]);
      const modes = await dataSource.query(
        `SELECT approval_mode FROM override_log_entries
          WHERE code = 'A-13' AND target_id = $1 ORDER BY created_at`,
        [target.id],
      );
      expect(modes).toEqual([{ approval_mode: 'SINGLE' }, { approval_mode: 'TWO_PERSON' }]);
    });

    it('refuses an operator changing or removing their own row', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const token = await signIn(admin.account);

      const change = await http()
        .patch(`/operator/operators/${admin.id}`)
        .set(bearer(token))
        .send({ roles: [], reasonCode: 'ROTATION', note: NOTE })
        .expect(403);
      expect(change.body.error.code).toBe('OPERATOR_SELF_CHANGE_REFUSED');
      await http()
        .post(`/operator/operators/${admin.id}/remove`)
        .set(bearer(token))
        .send({ reasonCode: 'LEFT', note: NOTE })
        .expect(403);
    });

    it('refuses an approver approving a raise of their own roles', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const other = await seedOperator([OperatorRole.OPS_ADMIN]);
      const queued = await http()
        .patch(`/operator/operators/${other.id}`)
        .set(bearer(await signIn(admin.account)))
        .send({
          roles: [OperatorRole.OPS_ADMIN, OperatorRole.TRE],
          reasonCode: 'ROTATION',
          note: NOTE,
        })
        .expect(202);

      const refused = await http()
        .post(`/operator/approvals/${queued.body.data.approvalId}/approve`)
        .set(bearer(await signIn(other.account)))
        .expect(403);
      expect(refused.body.error.code).toBe('OPERATOR_SELF_CHANGE_REFUSED');
    });

    it('removes an operator, single-person, and their live session stops at once', async () => {
      const admin = await seedOperator([OperatorRole.OPS_ADMIN]);
      const leaver = await seedOperator([OperatorRole.SRE]);
      const leaverToken = await signIn(leaver.account);
      await http().get('/operator/operators').set(bearer(leaverToken)).expect(200);

      const removed = await http()
        .post(`/operator/operators/${leaver.id}/remove`)
        .set(bearer(await signIn(admin.account)))
        .send({ reasonCode: 'LEFT', note: NOTE })
        .expect(200);
      expect(removed.body.data.status).toBe('REMOVED');

      await http().get('/operator/operators').set(bearer(leaverToken)).expect(401);
      const entry = await dataSource.query(
        `SELECT approval_mode FROM override_log_entries WHERE code = 'A-14' AND target_id = $1`,
        [leaver.id],
      );
      expect(entry).toEqual([{ approval_mode: 'SINGLE' }]);
    });

    it('refuses a removed operator whose session is still in Redis, on the next request', async () => {
      const leaver = await seedOperator([OperatorRole.SRE]);
      const token = await signIn(leaver.account);
      // Removed behind the console's back (e.g. `yarn operator:remove`): the
      // row is re-read within seconds, so the session ends without a revoke.
      await dataSource.query(
        `UPDATE operators SET status = 'REMOVED', removed_at = now() WHERE id = $1`,
        [leaver.id],
      );
      await new Promise((resolve) => setTimeout(resolve, 5_100));

      const refused = await http().get('/operator/operators').set(bearer(token)).expect(403);
      expect(refused.body.error.code).toBe('OPERATOR_NOT_AUTHORIZED');
    });
  });

  describe('a two-person route over HTTP', () => {
    it('answers 202 with an approvalId, and the approval answers with the route’s own result', async () => {
      const sre = await seedOperator([OperatorRole.SRE]);
      const lead = await seedOperator([OperatorRole.ADJL]);
      const sreToken = await signIn(sre.account);
      const org = randomUUID();

      const block = await http()
        .post('/operator/blocks')
        .set(bearer(sreToken))
        .send({ subjectKind: 'ORGANIZATION', subject: org, reasonCode: 'LEAKED_KEY', note: NOTE })
        .expect(201);

      const queued = await http()
        .post(`/operator/blocks/${block.body.data.id}/unblock`)
        .set(bearer(sreToken))
        .send({ reasonCode: 'KEY_ROTATED', note: NOTE })
        .expect(202);
      expect(queued.body.data).toMatchObject({ status: 'PENDING', action: 'account.unblock' });

      const leadToken = await signIn(lead.account);
      // The SRE who asked holds no role that approves anything.
      const byRequester = await http()
        .post(`/operator/approvals/${queued.body.data.approvalId}/approve`)
        .set(bearer(sreToken))
        .expect(403);
      expect(byRequester.body.error.code).toBe('OPERATOR_ROLE_REQUIRED');

      const approved = await http()
        .post(`/operator/approvals/${queued.body.data.approvalId}/approve`)
        .set(bearer(leadToken))
        .expect(200);
      expect(approved.body.data.result).toMatchObject({
        active: false,
        unblockApprovedBy: lead.subject,
      });
    });

    it('ignores an X-Operator-Approver header: the action is queued all the same', async () => {
      const sre = await seedOperator([OperatorRole.SRE]);
      const lead = await seedOperator([OperatorRole.ADJL]);
      const sreToken = await signIn(sre.account);
      const block = await http()
        .post('/operator/blocks')
        .set(bearer(sreToken))
        .send({
          subjectKind: 'ORGANIZATION',
          subject: randomUUID(),
          reasonCode: 'LEAKED_KEY',
          note: NOTE,
        })
        .expect(201);

      await http()
        .post(`/operator/blocks/${block.body.data.id}/unblock`)
        .set(bearer(sreToken))
        .set('X-Operator-Approver', await signIn(lead.account))
        .send({ reasonCode: 'KEY_ROTATED', note: NOTE })
        .expect(202);
    });
  });
});
