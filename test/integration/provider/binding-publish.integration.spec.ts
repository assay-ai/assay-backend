import { AddressInfo } from 'node:net';
import * as http from 'node:http';

import { ProviderErrorCode } from '@modules/provider/errors/provider.errors';
import { PublishRequirement } from '@modules/provider/domain/publish-gate';
import { BindingTestLayer, BindingTestOutcome } from '@modules/provider/ports/binding-test.types';
import { SaveToolBindingBodyDto } from '@modules/provider/dto/save-tool-binding.dto';
import { IneligibilityReason } from '@modules/tool/domain/routing/routing.types';
import { BindingStatus, PricingMode } from '@modules/tool/ports/tool.types';
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
 * A provider writes a binding, tests it, and publishes it — against a real
 * database and a real socket.
 *
 * This covers two requirements, end to end:
 *
 * > *"Test: publish is blocked when the tester has not run; blocked when the
 * > tester is red; blocked when stake is insufficient; passes when all three
 * > conditions are met."*
 * > *"Test: the tester must not charge anyone — check the ledger is unchanged
 * > before and after."*
 *
 * The unit suite covers the gate as a pure function and the tester against a
 * fixture. What only a database can show is the rest: that the revision a
 * green run was recorded against survives an edit, that publishing writes the
 * binding and stamps its snapshot together or not at all, and that a row can
 * never be `ACTIVE` without a published revision — the last one enforced by
 * Postgres rather than by the service that normally sets it.
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
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

function goodEndpoint(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data: { answer: 'forty-two' } }));
}

function rubbishEndpoint(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ nothing: 'the mapping can find' }));
}

function body(overrides: Partial<SaveToolBindingBodyDto> = {}): SaveToolBindingBodyDto {
  return {
    toolId: TOOL.id,
    endpoint: `http://provider.example.com/api`,
    requestMapping: { method: 'POST', path: '/search', body: { q: '$.query' } },
    responseMapping: { answer: '$.data.answer' },
    pricingMode: PricingMode.PAID,
    // $0.05, so the computed minimum is exactly the $50 floor.
    priceAmount: '50000',
    assetId: USDC_ASSET,
    // Required, and stated rather than derived. The service
    // deliberately does NOT fall back to `[chainIdOf(assetId)]`, so a fixture
    // that omits it reaches `assertChainsRoutable` as `undefined`. The `as
    // SaveToolBindingBodyDto` cast below hides that from the compiler, which is
    // why this was found only by running the suite.
    settlementChains: [STAKE_CHAIN],
    slaFailureRate: 0.02,
    timeoutMs: 30_000,
    ...overrides,
  } as SaveToolBindingBodyDto;
}

const usdc = (whole: number) =>
  MoneyUtil.of(String(BigInt(whole) * 1_000_000n), USDC_ASSET, USDC_DECIMALS);

let context: BindingEditorTestContext;

// Top level, not per-`describe`: Jest runs a describe's `afterAll` before the
// next describe's tests, so a server opened inside the first one is already
// closed by the time the second dials it.
beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => respond(req, res));
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
  respond = goodEndpoint;
});

describe('binding editor → mapping tester → publish gate', () => {
  it('refuses to publish a binding whose tester has never run', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());

    const check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(false);
    expect(
      check.requirements.find((r) => r.requirement === PublishRequirement.TESTER_RUN)?.code,
    ).toBe('tester_never_run');

    await expect(
      context.publisher.publish(context.organizationId, SUBJECT, binding.id),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_PUBLISH_CHECKS_FAILED });

    // Still a draft, and the row says so.
    const stored = await context.bindings.findOne({
      where: { organizationId: context.organizationId, id: binding.id },
    });
    expect(stored?.status).toBe(BindingStatus.DRAFT);
    expect(stored?.publishedVersion).toBeNull();
  });

  it('refuses to publish while the tester is red, and names the layer that failed', async () => {
    respond = rubbishEndpoint;

    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    const report = await context.tester.run(context.organizationId, SUBJECT, binding.id, {
      query: 'anything',
    });

    expect(report.outcome).toBe(BindingTestOutcome.FAILED);
    expect(report.failedLayer).toBe(BindingTestLayer.RESPONSE_MAPPING);

    const check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(false);

    const passed = check.requirements.find(
      (r) => r.requirement === PublishRequirement.TESTER_PASSED,
    );
    expect(passed?.code).toBe('tester_failed');
    expect(passed?.detail).toContain('RESPONSE_MAPPING');
  });

  it('refuses to publish when the stake is below the minimum, and says by how much', async () => {
    // The binding is WRITTEN while the stake is fine, and the stake drops
    // afterwards. A write-time chain gate exists, so creating a
    // binding under a $12 stake is now refused by `create` itself with
    // `PROVIDER_BINDING_CHAIN_STAKE_BELOW_MINIMUM` — and this test's subject is
    // the PUBLISH gate, which is a different gate answering a different
    // question. Dropping the stake between the two is also the real sequence: a
    // provider unstakes or is slashed after writing a binding, and the router
    // re-reads on every call for exactly that reason.
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());

    // $12 against a $50 floor.
    context.stakes.set(context.organizationId, usdc(12));
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'anything' });

    const check = await context.publisher.check(context.organizationId, binding.id);
    const stake = check.requirements.find(
      (r) => r.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    );

    expect(check.publishable).toBe(false);
    // The router's own reason and the router's own numbers — the publish gate
    // calls `evaluateStakeGate`, it does not re-derive the floor.
    expect(stake?.code).toBe(IneligibilityReason.STAKE_BELOW_MINIMUM);
    expect(stake?.detail).toContain('minimum 50.00');

    await expect(
      context.publisher.publish(context.organizationId, SUBJECT, binding.id),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_PUBLISH_CHECKS_FAILED });
  });

  it('fails closed when the stake source knows nothing about the provider', async () => {
    // Written first, then the stake source loses the provider — same reason as
    // the test above: the write-time gate would refuse `create` outright, and
    // the publish gate is what this asserts on.
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());

    context.stakes.set(context.organizationId, null);
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'anything' });

    const check = await context.publisher.check(context.organizationId, binding.id);
    const stake = check.requirements.find(
      (r) => r.requirement === PublishRequirement.STAKE_AT_MINIMUM_ON_EVERY_CHAIN,
    );

    // An RPC that failed and a provider who never bonded both produce
    // "absent", and the gate refuses both — while the reason still tells them
    // apart, so nobody is sent to top up an account that is already funded.
    expect(stake?.code).toBe(IneligibilityReason.STAKE_UNKNOWN);
  });

  /**
   * The publish half of "block both ends".
   *
   * A PAID binding whose provider has never proved a payout address serves
   * calls that settle with nobody to credit. The routing gate catches it on
   * every call; this catches it before the binding is ever live, which is the
   * only place a provider can be told about it while there is still something
   * they can do.
   */
  it('refuses to publish a PAID binding when no payout address has been proved', async () => {
    // Created with the enrolment in place, then the enrolment is removed —
    // The write-time gate refuses a binding on a chain the provider is not
    // enrolled on, so a provider with no enrolment at all cannot reach the
    // publish gate by that route. Removing it afterwards is the state this test
    // is about: a binding that exists and a payout address that does not.
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    await context.registerProvider({ payoutAccountId: null });
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'anything' });

    const check = await context.publisher.check(context.organizationId, binding.id);
    const payout = check.requirements.find(
      (r) => r.requirement === PublishRequirement.PAYOUT_ACCOUNT,
    );

    expect(check.publishable).toBe(false);
    // The router's own reason, so the console shows one vocabulary for
    // "unpayable" whether the refusal came from publish or from routing.
    expect(payout?.code).toBe(IneligibilityReason.PAYOUT_ACCOUNT_UNPROVED);
    // Legible: it names the condition and the remedy, not just a failed flag.
    expect(payout?.detail).toContain('has not proved a payout address');
    expect(payout?.detail).toContain('Prove a payout address');

    // Everything else about this binding is fine — tester green, stake at
    // $100 against a $50 floor — so this is the only thing standing in the way.
    expect(check.requirements.filter((r) => !r.met).map((r) => r.requirement)).toEqual([
      PublishRequirement.PAYOUT_ACCOUNT,
    ]);

    await expect(
      context.publisher.publish(context.organizationId, SUBJECT, binding.id),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_PUBLISH_CHECKS_FAILED });
  });

  it('publishes when all four hold, and stamps the revision snapshot with it', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    const report = await context.tester.run(context.organizationId, SUBJECT, binding.id, {
      query: 'the ultimate question',
    });
    expect(report.outcome).toBe(BindingTestOutcome.PASSED);

    const check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(true);

    const published = await context.publisher.publish(context.organizationId, SUBJECT, binding.id);

    expect(published.status).toBe(BindingStatus.ACTIVE);
    expect(published.publishedVersion).toBe(1);
    expect(published.hasUnpublishedChanges).toBe(false);

    // The snapshot is what a dispute reads, so publication is recorded on it
    // and not only on the live row.
    const snapshot = await context.versions.findOne({
      where: { organizationId: context.organizationId, bindingId: binding.id, mappingVersion: 1 },
    });
    expect(snapshot?.publishedBy).toBe(SUBJECT);
    expect(snapshot?.publishedAt).not.toBeNull();

    // And routing can now see it: the catalogue read is the router's, not the
    // console's, and it goes through the same port `ProviderRouterService` holds.
    // `findBindings` is the ROUTER's read — every provider's bindings for this
    // tool, in any state, which is exactly the port's contract. So this test's
    // own row is picked out of it rather than assumed to be the only one.
    const routable = await context.catalogue.findBindings(TOOL.id);
    const mine = routable.find((entry) => entry.providerId === context.organizationId);
    expect(mine?.id).toBe(binding.id);
    expect(mine?.status).toBe(BindingStatus.ACTIVE);
    expect(mine?.version).toBe(1);
  });

  it('refuses a second publish of a revision already live', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
    await context.publisher.publish(context.organizationId, SUBJECT, binding.id);

    await expect(
      context.publisher.publish(context.organizationId, SUBJECT, binding.id),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_BINDING_ALREADY_PUBLISHED });
  });

  it('a price edit restored to the published value returns to the published revision', async () => {
    // BUG-J-POSTP-02: 0.10 -> 0.11 -> 0.10 left the binding at v3 with "unpublished changes".
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
    await context.publisher.publish(context.organizationId, SUBJECT, binding.id);
    const price = body().priceAmount;

    const raised = await context.editor.update(context.organizationId, SUBJECT, binding.id, {
      priceAmount: String(BigInt(price) + 10_000n),
    });
    expect(raised.version).toBe(2);
    expect(raised.hasUnpublishedChanges).toBe(true);

    const restored = await context.editor.update(context.organizationId, SUBJECT, binding.id, {
      priceAmount: price,
    });
    expect(restored.version).toBe(1);
    expect(restored.hasUnpublishedChanges).toBe(false);
    // Revision 1's green run is still the one the gate reads.
    const check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.mappingVersion).toBe(1);
    expect(
      check.requirements.find((r) => r.requirement === PublishRequirement.TESTER_PASSED)?.met,
    ).toBe(true);

    // The next real edit is numbered past the abandoned draft, which is still stored.
    const next = await context.editor.update(context.organizationId, SUBJECT, binding.id, {
      priceAmount: String(BigInt(price) + 20_000n),
    });
    expect(next.version).toBe(3);
  });

  it('an edit after a green run invalidates it — the gate keys on the revision', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
    await context.publisher.publish(context.organizationId, SUBJECT, binding.id);

    // The provider changes where the answer comes from. Revision 2 has never
    // been near the tester.
    const edited = await context.editor.update(context.organizationId, SUBJECT, binding.id, {
      responseMapping: { answer: '$.data.other' },
    });
    expect(edited.version).toBe(2);
    expect(edited.hasUnpublishedChanges).toBe(true);

    const check = await context.publisher.check(context.organizationId, binding.id);
    expect(check.publishable).toBe(false);
    expect(
      check.requirements.find((r) => r.requirement === PublishRequirement.TESTER_RUN)?.code,
    ).toBe('tester_never_run');

    // Traffic is still served by revision 1 in the meantime: the catalogue
    // serves the published snapshot, not the draft on the row. (This used to
    // assert `version` 2 — the untested draft — under the same comment.)
    const routable = await context.catalogue.findBindings(TOOL.id);
    const mine = routable.find((entry) => entry.providerId === context.organizationId);
    expect(mine?.status).toBe(BindingStatus.ACTIVE);
    expect(mine?.version).toBe(1);
    expect(JSON.stringify(mine?.responseMapping)).not.toContain('$.data.other');

    // Re-testing the new revision reopens the gate. The endpoint has no
    // `$.data.other`, so this run is red — and the gate says so for the right
    // reason, not the stale one.
    await context.tester.run(context.organizationId, SUBJECT, binding.id, { query: 'x' });
    const afterRetest = await context.publisher.check(context.organizationId, binding.id);
    expect(
      afterRetest.requirements.find((r) => r.requirement === PublishRequirement.TESTER_RUN)?.met,
    ).toBe(true);
    expect(
      afterRetest.requirements.find((r) => r.requirement === PublishRequirement.TESTER_PASSED)
        ?.code,
    ).toBe('tester_failed');
  });

  it('refuses two bindings from one provider for one tool — Postgres decides, not a read', async () => {
    await context.editor.create(context.organizationId, SUBJECT, body());

    await expect(
      context.editor.create(context.organizationId, SUBJECT, body()),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_BINDING_ALREADY_EXISTS });
  });

  it('refuses an ACTIVE row with no published revision, at the database', async () => {
    const binding = await context.editor.create(context.organizationId, SUBJECT, body());

    // The publish gate is a service and a service can be bypassed — by a
    // repair script, a seeder, or a future caller. The row refuses anyway.
    await expect(
      context.dataSource.query(`UPDATE tool_bindings SET status = 'ACTIVE' WHERE id = $1`, [
        binding.id,
      ]),
    ).rejects.toThrow(/chk_tool_bindings_active_is_published/);
  });
});

describe('the provider’s own binding list, read from the binding editor’s table', () => {
  it('pages this provider’s bindings by createdAt, and nobody else’s', async () => {
    const mine = await context.editor.create(context.organizationId, SUBJECT, body());

    // A second provider, same tool. `uq_tool_bindings_organization_tool` allows
    // this — one binding per provider per tool, not one per tool.
    const otherOrganization = context.organizationId;
    await context.reset();
    await context.registerProvider();
    // `reset()` mints a NEW organization id, and the stake source is keyed by
    // it — so the $100 the outer `beforeEach` set belongs to the previous
    // provider. Because of the write-time chain gate, an unstaked provider cannot
    // create a PAID binding at all, and without this line the second `create`
    // fails with `no stake reading for provider …`.
    context.stakes.set(context.organizationId, usdc(100));
    const theirs = await context.editor.create(context.organizationId, SUBJECT, body());

    const page = await context.bindingsList.listBindings(context.organizationId, {
      limit: 25,
    } as never);

    expect(page.items.map((entry) => entry.id)).toEqual([theirs.id]);
    expect(page.items.map((entry) => entry.id)).not.toContain(mine.id);
    expect(otherOrganization).not.toBe(context.organizationId);

    // And the detail read is scoped the same way — a 404, never a 403.
    await expect(
      context.bindingsList.getBinding(context.organizationId, mine.id),
    ).rejects.toMatchObject({ errorCode: ProviderErrorCode.PROVIDER_BINDING_NOT_FOUND });
  });
});

describe('the mapping tester charges nobody', () => {
  it('leaves every ledger row byte-identical, on a run that succeeds and one that fails', async () => {
    // A ledger with something in it. Two empty tables would compare equal
    // against a tester that charged for every call.
    await context.fund(context.account('agent-integration'), 25_000_000n);
    await context.fund(context.account('provider-integration'), 5_000_000n);

    const before = await context.ledgerSnapshot();

    const binding = await context.editor.create(context.organizationId, SUBJECT, body());
    const green = await context.tester.run(context.organizationId, SUBJECT, binding.id, {
      query: 'the ultimate question',
    });

    respond = rubbishEndpoint;
    const red = await context.tester.run(context.organizationId, SUBJECT, binding.id, {
      query: 'the ultimate question',
    });

    expect(green.outcome).toBe(BindingTestOutcome.PASSED);
    expect(red.outcome).toBe(BindingTestOutcome.FAILED);

    const after = await context.ledgerSnapshot();
    expect(after).toEqual(before);

    // Both runs are on the record though — the call ids really went upstream,
    // and a provider who finds one in their access log has to be able to
    // resolve it.
    const runs = await context.runs.find({
      where: { organizationId: context.organizationId, bindingId: binding.id },
    });
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.callId)).size).toBe(2);
  });
});
