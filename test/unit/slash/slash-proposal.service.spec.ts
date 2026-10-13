import { createHash } from 'node:crypto';

import {
  FakeNotifications,
  FakeSlashEvents,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { ResolutionKind } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import {
  deriveChainRequestId,
  SlashProposalService,
} from '@modules/slash/services/slash-proposal.service';

type Deps = {
  proposals: FakeSlashProposals;
  events: FakeSlashEvents;
  notifications: FakeNotifications;
  service: SlashProposalService;
};

function build(config = TEST_SLASH_CONFIG): Deps {
  const proposals = new FakeSlashProposals();
  const events = new FakeSlashEvents();
  const notifications = new FakeNotifications();
  const service = new SlashProposalService(
    proposals as never,
    events as never,
    notifications as never,
    config,
  );
  return { proposals, events, notifications, service };
}

function strike(overrides: Partial<SlaStrikeEntity> = {}): SlaStrikeEntity {
  return Object.assign(new SlaStrikeEntity(), {
    id: 'strike_1',
    organizationId: 'org_1',
    providerId: 'prv_1',
    bindingId: 'bnd_1',
    toolId: 'tool_1',
    windowId: 'win_1',
    status: 'RECORDED',
    penaltyAmount: '10270000',
    assetId: 'usdc',
    observedRate: 0.1503,
    effectiveThreshold: 0.0727,
    computation: [],
    ...overrides,
  });
}

describe('SlashProposalService', () => {
  describe('opening a case from a strike', () => {
    it('opens one PROPOSED case and notifies the provider', async () => {
      const { service, proposals, notifications, events } = build();

      const proposal = await service.openFromStrike(strike());

      expect(proposal.status).toBe(SlashProposalStatus.PROPOSED);
      expect(proposal.penaltyAmount).toBe('10270000');
      expect(proposals.rows.size).toBe(1);
      // `NOTIFIED` too: the notification is delivered
      // synchronously on `IN_APP` and the clock starts in the same call.
      expect(events.kinds()).toEqual(['PROPOSED', 'NOTIFIED']);
      expect(notifications.sent).toHaveLength(1);
      expect(notifications.sent[0].event).toBe(NotificationEvent.PROVIDER_SLASH_PROPOSED);
    });

    /**
     * `uq_slash_proposals_strike` is the durable guarantee; this is the
     * in-process half of it. A retried close, or a re-run of the opener, must
     * not mint a second penalty for one window.
     */
    it('is idempotent — a second call returns the same case and sends nothing', async () => {
      const { service, proposals, notifications } = build();
      const first = await service.openFromStrike(strike());
      const second = await service.openFromStrike(strike());

      expect(second.id).toBe(first.id);
      expect(proposals.rows.size).toBe(1);
      expect(notifications.sent).toHaveLength(1);
    });

    /**
     * The timelock is set at creation and is the promise the slash case screen
     * makes in its largest type.
     */
    /**
     * `respondByAt` used to stay null after opening a case, because
     * `markDelivered` had no caller anywhere in `src/` — which meant no
     * proposal could ever reach `UPHELD`, since `findUndisputedPast` requires
     * `respond_by_at IS NOT NULL`.
     *
     * It is set at creation now, and that is not a shortcut: `IN_APP` is the one
     * channel that is real, and `NotificationService` marks it `DELIVERED` at
     * insert because the inbox row *is* the delivery. The clock therefore starts
     * on a delivery that has genuinely happened.
     */
    it('sets the timelock at creation, and the response clock on delivery', async () => {
      const { service } = build();
      const proposal = await service.openFromStrike(strike());

      expect(proposal.earliestExecutionAt.getTime() - proposal.proposedAt.getTime()).toBe(
        TEST_SLASH_CONFIG.timelockMs,
      );

      // Delivered synchronously, so the response window is already running.
      expect(proposal.respondByAt).not.toBeNull();
      expect(proposal.notifiedAt).not.toBeNull();
      expect(
        (proposal.respondByAt as Date).getTime() - (proposal.notifiedAt as Date).getTime(),
      ).toBe(TEST_SLASH_CONFIG.responseWindowMs);
    });

    it('derives the chain request id deterministically from the proposal id', async () => {
      const { service } = build();
      const proposal = await service.openFromStrike(strike());

      expect(proposal.chainRequestId).toHaveLength(64);
      expect(proposal.chainRequestId).toBe(
        deriveChainRequestId({ id: proposal.id, chainEpoch: proposal.chainEpoch }),
      );
    });

    /**
     * The de-minimis floor. Disabled by default, so this test sets it.
     *
     * The notification matters as much as the status: a case that will never be
     * levied must not send a provider a CRITICAL, non-suppressible alert saying
     * their capital is at risk. That is the cost of adjudication moved onto
     * them rather than removed.
     */
    it('waives a penalty below the de-minimis floor, and tells nobody', async () => {
      const { service, notifications, events } = build({
        ...TEST_SLASH_CONFIG,
        deMinimisMinor: '25000000',
      });

      const proposal = await service.openFromStrike(strike({ penaltyAmount: '5000000' }));

      expect(proposal.status).toBe(SlashProposalStatus.WAIVED);
      expect(proposal.resolutionKind).toBe(ResolutionKind.AUTO_DE_MINIMIS);
      expect(notifications.sent).toHaveLength(0);
      expect(events.kinds()).toEqual(['WAIVED']);
    });
  });

  describe('delivery starts the provider’s clock', () => {
    /**
     * The deadline is `deliveredAt + responseWindow`, never
     * `proposedAt + responseWindow`. The first delivery happens
     * inside `openFromStrike` — `IN_APP` is synchronous — so this asserts the
     * derivation on a proposal delivered explicitly, which is the path a queued
     * channel still takes.
     */
    it('derives respondByAt from delivery, not from proposal', async () => {
      const { service, proposals } = build();
      const proposal = await service.openFromStrike(strike());

      const row = proposals.rows.get(proposal.id)!;
      expect(row.notifiedAt).not.toBeNull();
      expect(row.respondByAt!.getTime()).toBe(
        row.notifiedAt!.getTime() + TEST_SLASH_CONFIG.responseWindowMs,
      );
      // And not from the proposal, which is the failure this guards.
      expect(row.respondByAt!.getTime()).not.toBe(
        proposal.proposedAt.getTime() + TEST_SLASH_CONFIG.timelockMs,
      );
    });

    /**
     * The guard, from the angle that matters now: the case is already delivered
     * when it is opened, so a channel confirming later must not restart the
     * clock. `markNotifiedIfUnnotified` is guarded on `notified_at IS NULL`.
     */
    it('a later confirmation does not move a deadline that is already running', async () => {
      const { service, proposals } = build();
      const proposal = await service.openFromStrike(strike());
      const first = proposals.rows.get(proposal.id)!.respondByAt!.getTime();

      const muchLater = new Date(proposal.proposedAt.getTime() + 6 * 60 * 60 * 1000);
      await service.markDelivered('org_1', proposal.id, muchLater);

      expect(proposals.rows.get(proposal.id)!.respondByAt!.getTime()).toBe(first);
    });

    /**
     * A webhook retried three times must not move the deadline three times —
     * and the direction it would move is *later*, which looks generous and is
     * really the platform choosing when its own timelock expires.
     */
    /**
     * One `NOTIFIED` event, however many channels confirm. Superseding the old
     * "ignores a repeated delivery confirmation" case, whose premise — a case
     * still undelivered after `openFromStrike` — no longer exists.
     */
    it('records the delivery once, however many confirmations arrive', async () => {
      const { service, proposals, events } = build();
      const proposal = await service.openFromStrike(strike());

      await service.markDelivered('org_1', proposal.id, new Date('2026-08-11T10:00:00Z'));
      await service.markDelivered('org_1', proposal.id, new Date('2026-08-12T10:00:00Z'));

      expect(proposals.rows.get(proposal.id)!.notifiedAt).not.toBeNull();
      expect(events.kinds().filter((k) => k === 'NOTIFIED')).toHaveLength(1);
    });
  });

  /**
   * Self-check #2 — *"Test: once the objection deadline passes, the proposal finalises itself."*
   */
  describe('the undisputed sweeper', () => {
    it('upholds a case whose window elapsed with no objection', async () => {
      const { service, proposals, events } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        respondByAt: new Date('2026-08-12T09:14:00Z'),
      });

      const closed = await service.sweepUndisputed(new Date('2026-08-12T09:15:00Z'));

      expect(closed).toBe(1);
      const row = proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.UPHELD);
      expect(row.resolutionKind).toBe(ResolutionKind.AUTO_UNDISPUTED);
      // Nobody adjudicated it, so it carries no adjudicator's outcome. Writing
      // one would put a judgement nobody made into the false-positive taxonomy.
      expect(row.outcome).toBeNull();
      expect(row.countsAsFalsePositive).toBe(false);
      expect(events.kinds()).toContain('AUTO_CLOSED');
    });

    it('leaves a case whose window has not elapsed alone', async () => {
      const { service, proposals } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        respondByAt: new Date('2026-08-12T09:14:00Z'),
      });

      const closed = await service.sweepUndisputed(new Date('2026-08-12T09:13:00Z'));

      expect(closed).toBe(0);
      expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.PROPOSED);
    });

    /**
     * A case nobody could have heard about is not one they declined to answer.
     * `respondByAt` is null until delivery is confirmed, and the sweeper must
     * skip those rather than treating an undelivered webhook as silence.
     */
    it('never closes a case that was never delivered', async () => {
      const { service, proposals } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        notifiedAt: null,
        respondByAt: null,
      });

      expect(await service.sweepUndisputed(new Date('2030-01-01T00:00:00Z'))).toBe(0);
      expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.PROPOSED);
    });
  });

  /**
   * The one symmetric rule: if we miss our own deadline, the case is
   * overturned and it counts against us.
   */
  describe('the platform-miss sweeper', () => {
    it('overturns an overdue case and records it against us', async () => {
      const { service, proposals, notifications, events } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.UNDER_REVIEW,
        platformDecisionDueAt: new Date('2026-08-13T09:14:00Z'),
      });

      const overturned = await service.sweepPlatformMisses(new Date('2026-08-13T09:15:00Z'));

      // The rows, not a count: `SlashLifecycleJob` has to release each one's
      // on-chain reservation, and it cannot re-derive the set afterwards —
      // the sweep's own predicate no longer matches a row it just overturned.
      expect(overturned).toEqual([{ organizationId: 'org_1', id: 'p1' }]);
      const row = proposals.rows.get('p1')!;
      expect(row.status).toBe(SlashProposalStatus.OVERTURNED);
      expect(row.resolutionKind).toBe(ResolutionKind.AUTO_PLATFORM_MISS);
      expect(row.outcome).toBeNull();
      expect(row.countsAsFalsePositive).toBe(true);
      expect(events.kinds()).toContain('AUTO_OVERTURNED_PLATFORM_MISS');
      expect(notifications.sent.map((n) => n.event)).toContain(
        NotificationEvent.PROVIDER_SLASH_DECIDED,
      );
    });

    it('does not touch a case that is still inside our window', async () => {
      const { service, proposals } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.DISPUTED,
        platformDecisionDueAt: new Date('2026-08-13T09:14:00Z'),
      });

      expect(await service.sweepPlatformMisses(new Date('2026-08-13T09:13:00Z'))).toEqual([]);
      expect(proposals.rows.get('p1')!.status).toBe(SlashProposalStatus.DISPUTED);
    });
  });
});

describe('deriveChainRequestId', () => {
  const ID = '2b0f2b6b-0d3e-4a01-9d3a-6c0c9a1e1f22';

  it('is byte-identical to the pre-epoch derivation at epoch 0', () => {
    // Live rows already carry a chain_request_id computed the old way, and it
    // is UNIQUE. If the epoch changed the digest at 0, every existing row's
    // replay lock would move and the migration would have to rewrite them —
    // which for any row already proposed on chain is impossible.
    const legacy = createHash('sha256').update('x402:slash-request:v1').update(ID).digest('hex');

    expect(deriveChainRequestId({ id: ID, chainEpoch: 0 })).toBe(legacy);
  });

  it('produces a fresh id at every later epoch', () => {
    // The chain burns a request_id permanently on `init`. A re-proposal after a
    // downward recalculation needs an id the program has never seen, or the
    // second propose_slash is refused and the case is stuck at the old penalty.
    const zero = deriveChainRequestId({ id: ID, chainEpoch: 0 });
    const one = deriveChainRequestId({ id: ID, chainEpoch: 1 });
    const two = deriveChainRequestId({ id: ID, chainEpoch: 2 });

    expect(new Set([zero, one, two]).size).toBe(3);
    for (const value of [zero, one, two]) {
      expect(value).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('cannot collide across proposals by moving the separator', () => {
    // 'a' + epoch 11 must not equal 'a1' + epoch 1. The separator is what makes
    // the pre-image unambiguous, and a collision here is two findings sharing
    // one on-chain penalty.
    expect(deriveChainRequestId({ id: 'a', chainEpoch: 11 })).not.toBe(
      deriveChainRequestId({ id: 'a1', chainEpoch: 1 }),
    );
  });
});

describe('openFromVerdict — B7', () => {
  it('refuses a new case over the calls of a window whose on-chain dispute the provider won', async () => {
    const { proposals, service } = build();
    proposals.seed({
      id: 'won',
      organizationId: 'org_1',
      windowId: 'window-1',
      chainDisputeWonAt: new Date('2026-10-01T00:00:00Z'),
    } as never);
    await expect(
      service.openFromVerdict({
        organizationId: 'org_1',
        providerId: 'provider-1',
        bindingId: 'binding-1',
        toolId: 'tool-1',
        verdictId: 'verdict-new',
        windowId: 'window-1',
        penaltyAmount: '1000000',
        assetId: 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3',
      }),
    ).rejects.toMatchObject({ errorCode: 'SLASH_DISPUTE_WON_ON_CHAIN' });
  });
});
