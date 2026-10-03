import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AccountBalanceRepository } from '@database/postgres/repositories/account-balance.repository';
import { ReconciliationRunRepository } from '@database/postgres/repositories/reconciliation-run.repository';
import { StakeSnapshotRepository } from '@database/postgres/repositories/stake-snapshot.repository';
import { PublicReservesController } from '@modules/settlement/controllers/public-reserves.controller';
import { PublicReservesState } from '@modules/settlement/domain/public-reserves';
import {
  PUBLIC_RESERVES_CONFIG,
  PublicReservesService,
} from '@modules/settlement/services/public-reserves.service';
import { chainIdOf } from '@modules/chains/ports/caip.types';
import { AllExceptionsFilter } from '@shared/filters/all-exceptions.filter';
import { TransformInterceptor } from '@shared/interceptors/transform.interceptor';

import {
  SettlementTestContext,
  USDC_ASSET,
  createSettlementTestContext,
} from '../helpers/settlement-test-context';

/**
 * `GET /api/v1/public/reserves` over real HTTP, against real rows.
 *
 * The one claim that cannot be made by a unit test is the one this endpoint is
 * for: that it answers **with no Authorization header at all**. Every other
 * surface in this codebase refuses that, so proving it here means going through
 * the real routing and the real filter rather than calling the service.
 */
describe('GET /public/reserves — anonymous', () => {
  let context: SettlementTestContext;
  let app: INestApplication;

  beforeAll(async () => {
    context = await createSettlementTestContext();

    const moduleRef = await Test.createTestingModule({
      controllers: [PublicReservesController],
      providers: [
        PublicReservesService,
        { provide: PUBLIC_RESERVES_CONFIG, useValue: { assets: [USDC_ASSET], historyLimit: 4 } },
        {
          provide: ReconciliationRunRepository,
          useValue: new ReconciliationRunRepository(context.dataSource),
        },
        {
          provide: StakeSnapshotRepository,
          useValue: new StakeSnapshotRepository(context.dataSource),
        },
        {
          provide: AccountBalanceRepository,
          useValue: new AccountBalanceRepository(context.dataSource),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new TransformInterceptor());
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await context?.close();
  });

  beforeEach(async () => {
    await context.reset();
  });

  it('answers 200 with the four figures and no bearer token on the wire', async () => {
    const agent = context.account('Reserves111111111111111111111111111111111');
    await context.fund(agent, 10_000_000n);
    context.setVaultBalance(10_000_000n);
    await context.reconciliation.reconcile(USDC_ASSET);

    const response = await request(app.getHttpServer()).get('/api/public/reserves').expect(200);

    // No `.set('Authorization', …)` above, deliberately — that absence is the
    // assertion.
    // The payload is a LIST of chains and carries no cross-chain total.
    expect(Object.keys(response.body.data)).toEqual(['chains']);
    expect(response.body.data.chains).toHaveLength(1);
    expect(response.body.data.chains[0]).toMatchObject({
      chainId: chainIdOf(USDC_ASSET),
      asset: USDC_ASSET,
      state: PublicReservesState.NORMAL,
      vaultBalance: '10000000',
      totalLiabilities: '10000000',
      difference: '0',
      accounts: 1,
    });
    expect(response.body.data.chains[0].history).toHaveLength(1);
  });

  it('says no reconciliation has happened, still 200, on a fresh deployment', async () => {
    const response = await request(app.getHttpServer()).get('/api/public/reserves').expect(200);

    expect(response.body.data.chains[0]).toMatchObject({
      state: PublicReservesState.NO_RECONCILIATION,
      // Even with no run the panel names its own network — a blank panel would
      // read as "there is no such chain" rather than "nobody has checked".
      chainId: chainIdOf(USDC_ASSET),
      vaultBalance: null,
      difference: null,
    });
    expect(response.body.data.chains[0].history).toEqual([]);
  });

  it('carries the vault slot the reconciler recorded', async () => {
    await context.fund(context.account('Slot11111111111111111111111111111111111'), 5_000_000n);
    context.setVaultBalance(5_000_000n);
    await context.reconciliation.reconcile(USDC_ASSET);

    const response = await request(app.getHttpServer()).get('/api/public/reserves').expect(200);

    expect(response.body.data.chains[0].vaultSlot).not.toBeNull();
  });

  it('reports a shortfall with its sign rather than as zero', async () => {
    await context.fund(context.account('Short1111111111111111111111111111111111'), 9_000_000n);
    context.setVaultBalance(8_000_000n);
    await context.reconciliation.reconcile(USDC_ASSET);

    const response = await request(app.getHttpServer()).get('/api/public/reserves').expect(200);

    expect(response.body.data.chains[0].difference).toBe('-1000000');
  });
});
