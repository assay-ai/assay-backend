import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import {
  BindingAuthMode,
  BindingPauseReason,
  BindingStatus,
  PricingMode,
} from '@modules/tool/ports/tool.types';
import { EgressHttpClient } from '@shared/network/egress';
import { MoneyUtil } from '@shared/utils/money.util';

import { plainInvoker } from '../../unit/tool/helpers/routing-fixtures';
import {
  BindingEditorTestContext,
  STAKE_CHAIN,
  TOOL,
  USDC_ASSET,
  USDC_DECIMALS,
  createBindingEditorTestContext,
} from '../helpers/binding-editor-test-context';

/**
 * A paused binding has to say who paused it.
 *
 * `PAUSED` carries two causes with opposite consequences. The provider's own
 * pause is a choice — **no penalty, no mark in the quality profile**, because
 * declining to serve is not failing to serve. The SLA health circuit opening
 * is a fault, and it has to be recorded as one;
 * `IneligibilityReason.BINDING_NOT_ACTIVE` already documents its own case as
 * *"`PAUSED` (circuit open)"*, so both will write this same status value.
 *
 * A status that cannot tell them apart is a status that answers "why did my
 * traffic stop" wrongly half the time, and the cause is not recoverable
 * afterwards — a `PAUSED` row is silent about how it got there. So
 * `chk_tool_bindings_pause_attributed` makes the pairing a property of the row
 * rather than of the service that normally writes it.
 *
 * Both directions are asserted, because the constraint is a **biconditional**.
 * A one-way check would let a `pause_reason` survive a resume, which is the
 * more insidious failure: the binding serves traffic while still carrying a
 * reason that the console would render as an explanation for a stoppage that
 * ended weeks ago.
 *
 * This is the same argument, and the same shape, as
 * `binding-publish.integration.spec.ts`'s last case. `BindingPauseService`
 * writes these fields correctly — the second `describe` below is that service —
 * and the row still refuses a bare `UPDATE`, because a repair script, a seeder
 * or the SLA health breaker are all callers that will never go through it.
 */
const SUBJECT = 'cred-integration';
const PROVIDER_ADDRESS = '93.184.216.34';

const lookup = jest.fn(async (hostname: string) => {
  if (hostname.endsWith('.example.com')) return [{ address: PROVIDER_ADDRESS, family: 4 as const }];
  const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
  error.code = 'ENOTFOUND';
  throw error;
});

let server: http.Server;
let port: number;
const openSockets: Array<{ destroy: () => void }> = [];

function body(): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: `http://provider.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    // $0.05, so the computed minimum is exactly the $50 floor.
    priceAmount: '50000',
    assetId: USDC_ASSET,
    // Declared explicitly. The one chain this context provisions — `STAKE_CHAIN` is
    // the chain `USDC_ASSET` names and the chain the fixture's payout enrolment
    // and stake are both written under. Nothing here is about chains.
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 30_000,
    authMode: BindingAuthMode.NONE,
  } as SaveToolBindingBodyDto;
}

const usdc = (whole: number) =>
  MoneyUtil.of(String(BigInt(whole) * 1_000_000n), USDC_ASSET, USDC_DECIMALS);

let context: BindingEditorTestContext;

beforeAll(async () => {
  // The tester dials the endpoint for real, and publishing needs a green run.
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
    });
  });
  server.on('connection', (socket) => openSockets.push(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;

  const invoker = plainInvoker(
    new EgressHttpClient(lookup, (target) => ({
      address: '127.0.0.1',
      family: 4,
      port: target.port === 80 ? port : target.port,
    })),
  );

  context = await createBindingEditorTestContext(invoker);
});

afterAll(async () => {
  await context.close();
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  await context.reset();
  await context.registerProvider();
  context.stakes.set(context.organizationId, usdc(100));
});

/**
 * A published, `ACTIVE` binding — the only state a pause is reachable from.
 *
 * Pausing a `DRAFT` would trip `chk_tool_bindings_active_is_published` first
 * (a `PAUSED` binding is a *published* binding whose traffic is off, not a
 * draft), and a test that passed because the other constraint fired would
 * prove nothing about this one.
 */
async function publishedBindingId(): Promise<string> {
  const binding = await context.editor.create(context.organizationId, SUBJECT, body());
  await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
  const published = await context.publisher.publish(context.organizationId, SUBJECT, binding.id);
  expect(published.status).toBe(BindingStatus.ACTIVE);
  return binding.id;
}

describe('a paused binding says who paused it', () => {
  it('refuses a PAUSED binding with no reason, even by raw UPDATE', async () => {
    const bindingId = await publishedBindingId();

    await expect(
      context.dataSource.query(`UPDATE tool_bindings SET status = 'PAUSED' WHERE id = $1`, [
        bindingId,
      ]),
    ).rejects.toThrow(/chk_tool_bindings_pause_attributed/);

    // And the row did not move — the refusal is a refusal, not a warning.
    const stored = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(stored?.status).toBe(BindingStatus.ACTIVE);
    expect(stored?.pauseReason).toBeNull();
  });

  it('refuses a reason on a binding that is still serving — the check is a biconditional', async () => {
    const bindingId = await publishedBindingId();

    await expect(
      context.dataSource.query(`UPDATE tool_bindings SET pause_reason = 'PROVIDER' WHERE id = $1`, [
        bindingId,
      ]),
    ).rejects.toThrow(/chk_tool_bindings_pause_attributed/);
  });

  it('accepts the pair, and accepts dropping the pair again', async () => {
    const bindingId = await publishedBindingId();

    await context.dataSource.query(
      `UPDATE tool_bindings
          SET status = 'PAUSED', pause_reason = 'PROVIDER', paused_at = now()
        WHERE id = $1`,
      [bindingId],
    );

    const paused = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(paused?.status).toBe(BindingStatus.PAUSED);
    expect(paused?.pauseReason).toBe('PROVIDER');
    expect(paused?.pausedAt).not.toBeNull();

    // Resuming has to clear the reason in the same statement. A resume that
    // left it behind is exactly what the second test above forbids, so the
    // constraint is what makes "clear it on resume" unforgettable.
    await context.dataSource.query(
      `UPDATE tool_bindings
          SET status = 'ACTIVE', pause_reason = NULL, paused_at = NULL
        WHERE id = $1`,
      [bindingId],
    );

    const resumed = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(resumed?.status).toBe(BindingStatus.ACTIVE);
    expect(resumed?.pauseReason).toBeNull();
  });
});

describe('the ceilings ride on the routing candidate', () => {
  it('carries maxRps and maxDailyCalls through the catalogue the router reads', async () => {
    const bindingId = await publishedBindingId();

    // No editor path writes these yet.
    // What matters here is that the mapper carries them, because the router
    // reads `ToolBinding` off the candidate and must never go back to the
    // database per candidate to learn a ceiling.
    await context.dataSource.query(
      `UPDATE tool_bindings SET max_rps = 25, max_daily_calls = 10000 WHERE id = $1`,
      [bindingId],
    );

    const routable = await context.catalogue.findBindings(TOOL.id);
    const mine = routable.find((entry) => entry.id === bindingId);

    expect(mine?.maxRps).toBe(25);
    expect(mine?.maxDailyCalls).toBe(10_000);
  });

  it('defaults both to null — no ceiling declared, which is not a ceiling of zero', async () => {
    const bindingId = await publishedBindingId();

    const routable = await context.catalogue.findBindings(TOOL.id);
    const mine = routable.find((entry) => entry.id === bindingId);

    expect(mine?.maxRps).toBeNull();
    expect(mine?.maxDailyCalls).toBeNull();
  });
});

/**
 * The provider's own hand on their own traffic.
 *
 * The requirement is a per-binding pause that cuts traffic
 * **within 5 seconds**, with no penalty, no effect on accrued earnings and no
 * mark in the quality profile. The five-second half needs no machinery here and
 * that is the point worth stating: `DatabaseToolCatalogue` holds no cache, the
 * router reads `tool_bindings` per routing decision, and `filterEligible`
 * already refuses anything that is not `ACTIVE`. So the pause takes effect on
 * the next call, and the first test below reads the catalogue back to prove it
 * rather than trusting the claim. The verification kill switch uses pub/sub because
 * *policies* are held in process; a binding never is.
 *
 * The "no mark" half is the one a test can get wrong by asserting nothing. What
 * is checkable here is what this context can see: the ledger (every accrued
 * cent), the `providers` row, and the binding's own quality-bearing fields.
 * `verification_records` — the table `ProviderQualityService` actually reads —
 * has no schema in this context and no writer on this path, which is the
 * stronger statement of the two: the pause path never touches a verdict
 * because it imports nothing that can.
 */
describe('a provider pauses and resumes their own binding', () => {
  it('sets PAUSED with pause_reason = PROVIDER_REQUESTED', async () => {
    const bindingId = await publishedBindingId();

    const paused = await context.pauser.pause(context.organizationId, bindingId, {
      reason: 'upstream maintenance window',
    });

    expect(paused.status).toBe(BindingStatus.PAUSED);
    expect(paused.pauseReason).toBe(BindingPauseReason.PROVIDER_REQUESTED);
    expect(paused.pausedAt).not.toBeNull();

    const stored = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(stored?.status).toBe(BindingStatus.PAUSED);
    expect(stored?.pauseReason).toBe(BindingPauseReason.PROVIDER_REQUESTED);
    expect(stored?.pausedAt).not.toBeNull();

    // The five-second requirement, without a single line of invalidation: the
    // next read of the catalogue the router uses already says PAUSED.
    const routable = await context.catalogue.findBindings(TOOL.id);
    expect(routable.find((entry) => entry.id === bindingId)?.status).toBe(BindingStatus.PAUSED);
  });

  it('records nothing in the quality profile and touches no accrued earnings', async () => {
    const bindingId = await publishedBindingId();
    await context.fund(context.account('agent-pause'), 5_000_000n);

    const ledgerBefore = await context.ledgerSnapshot();
    const providerBefore = await context.dataSource.query('SELECT * FROM providers');
    const runsBefore = await context.dataSource.query('SELECT * FROM binding_test_runs');
    const versionsBefore = await context.dataSource.query('SELECT * FROM binding_versions');
    const before = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });

    await context.pauser.pause(context.organizationId, bindingId);

    // Declining to serve is not failing to serve. Nothing that feeds a score,
    // a strike or a payout may move.
    expect(await context.ledgerSnapshot()).toEqual(ledgerBefore);
    expect(await context.dataSource.query('SELECT * FROM providers')).toEqual(providerBefore);
    expect(await context.dataSource.query('SELECT * FROM binding_test_runs')).toEqual(runsBefore);
    expect(await context.dataSource.query('SELECT * FROM binding_versions')).toEqual(
      versionsBefore,
    );

    const after = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    // The declared SLA is the provider's own quality commitment and the
    // revision is what a dispute is argued over. A pause changes neither.
    expect(after?.slaFailureRate).toBe(before?.slaFailureRate);
    expect(after?.mappingVersion).toBe(before?.mappingVersion);
    expect(after?.publishedVersion).toBe(before?.publishedVersion);
    expect(after?.publishedAt).toEqual(before?.publishedAt);
  });

  it('resume clears both pause_reason and paused_at', async () => {
    const bindingId = await publishedBindingId();
    await context.pauser.pause(context.organizationId, bindingId);

    const resumed = await context.pauser.resume(context.organizationId, bindingId);

    expect(resumed.status).toBe(BindingStatus.ACTIVE);
    expect(resumed.pauseReason).toBeNull();
    expect(resumed.pausedAt).toBeNull();

    const stored = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(stored?.status).toBe(BindingStatus.ACTIVE);
    expect(stored?.pauseReason).toBeNull();
    expect(stored?.pausedAt).toBeNull();
    // Resuming is not republishing: the revision that was live is still live.
    expect(stored?.publishedVersion).toBe(stored?.mappingVersion);
  });

  it('refuses to pause a binding the caller does not own', async () => {
    const bindingId = await publishedBindingId();

    await expect(context.pauser.pause(randomUUID(), bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND,
    });

    const stored = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: bindingId },
    });
    expect(stored?.status).toBe(BindingStatus.ACTIVE);
  });

  it('refuses to resume a binding that has never been published', async () => {
    // `chk_tool_bindings_active_is_published` forbids `ACTIVE` — and `PAUSED` —
    // on a row with no `published_version`, so a resume that only flipped the
    // status would reach Postgres and come back as a constraint violation with
    // nothing a provider could act on. The refusal names the remedy instead.
    const draft = await context.editor.create(context.organizationId, SUBJECT, body());
    expect(draft.status).toBe(BindingStatus.DRAFT);

    await expect(context.pauser.resume(context.organizationId, draft.id)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NEVER_PUBLISHED,
    });
  });

  it('refuses to pause a binding that is not serving, and to resume one that is', async () => {
    const bindingId = await publishedBindingId();

    // Both refusals exist for the same reason: the console shows one button,
    // and a button that silently does nothing when the view is stale is worse
    // than one that says the view is stale.
    await expect(context.pauser.resume(context.organizationId, bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_PAUSED,
    });

    await context.pauser.pause(context.organizationId, bindingId);
    await expect(context.pauser.pause(context.organizationId, bindingId)).rejects.toMatchObject({
      errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_PAUSABLE,
    });
  });
});
