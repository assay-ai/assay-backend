import { createHash } from 'node:crypto';

import {
  FakeNotifications,
  FakeSlashEvents,
  FakeSlashProposals,
  TEST_SLASH_CONFIG,
} from './helpers/fake-slash-repositories';
import { SlaStrikeEntity } from '@database/postgres/entities/sla-strike.entity';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { NotificationEvent } from '@modules/notification/ports/notification.port';
import { ResolutionKind } from '@modules/slash/domain/arbitration';
import { SlashProposalStatus } from '@modules/slash/domain/slash-proposal-state';
import {
  deriveChainRequestId,
  SlashProposalService,
} from '@modules/slash/services/slash-proposal.service';

const EVM_ASSET = 'eip155:46630/erc20:0xdbbc156dd414f43f2c952c1be0f16a0b9a826cd3';

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
    assetId: EVM_ASSET,
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

      const proposal = (await service.openFromStrike(strike()))!;

      expect(proposal.status).toBe(SlashProposalStatus.PROPOSED);
      expect(proposal.penaltyAmount).toBe('10270000');
      expect(proposals.rows.size).toBe(1);
      // `NOTIFIED` too: the notification is delivered
      // synchronously on `IN_APP` and the clock starts in the same call.
      expect(events.kinds()).toEqual(['PROPOSED', 'NOTIFIED']);
      expect(notifications.sent).toHaveLength(1);
      expect(notifications.sent[0].event).toBe(NotificationEvent.PROVIDER_SLASH_PROPOSED);
      // Dollars, not minor units, and no ISO timestamp in the provider's words.
      expect(notifications.sent[0].title).toBe(
        'A penalty of up to $10.27 is proposed against your stake',
      );
      expect(notifications.sent[0].body).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    /**
     * `uq_slash_proposals_strike` is the durable guarantee; this is the
     * in-process half of it. A retried close, or a re-run of the opener, must
     * not mint a second penalty for one window.
     */
    it('is idempotent — a second call returns the same case and sends nothing', async () => {
      const { service, proposals, notifications } = build();
      const first = (await service.openFromStrike(strike()))!;
      const second = (await service.openFromStrike(strike()))!;

      expect(second.id).toBe(first.id);
      expect(proposals.rows.size).toBe(1);
      expect(notifications.sent).toHaveLength(1);
    });

    /**
     * The timelock is set at creation and is the promise the slash case screen
     * makes in its largest type. `IN_APP` is delivered at insert, so delivery is
     * recorded in the same call; no response clock starts from it.
     */
    it('sets the timelock at creation and records the delivery', async () => {
      const { service } = build();
      const proposal = (await service.openFromStrike(strike()))!;

      expect(proposal.earliestExecutionAt.getTime() - proposal.proposedAt.getTime()).toBe(
        TEST_SLASH_CONFIG.timelockMs,
      );
      expect(proposal.notifiedAt).not.toBeNull();
    });

    /**
     * Solana has no slash path: no paid rail, no dispute, and its single-record
     * judgement named the retired pooled vault as beneficiary.
     */
    it('opens no case for a Solana strike, and tells nobody', async () => {
      const { service, proposals, notifications } = build();

      const proposal = await service.openFromStrike(
        strike({ assetId: ASSET_IDS.USDC_SOLANA_DEVNET }),
      );

      expect(proposal).toBeNull();
      expect(proposals.rows.size).toBe(0);
      expect(notifications.sent).toHaveLength(0);
    });

    it('derives the chain request id deterministically from the proposal id', async () => {
      const { service } = build();
      const proposal = (await service.openFromStrike(strike()))!;

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

      const proposal = (await service.openFromStrike(strike({ penaltyAmount: '5000000' })))!;

      expect(proposal.status).toBe(SlashProposalStatus.WAIVED);
      expect(proposal.resolutionKind).toBe(ResolutionKind.AUTO_DE_MINIMIS);
      expect(notifications.sent).toHaveLength(0);
      expect(events.kinds()).toEqual(['WAIVED']);
    });
  });

  describe('delivery', () => {
    /**
     * One `NOTIFIED` event, however many channels confirm:
     * `markNotifiedIfUnnotified` is guarded on `notified_at IS NULL`.
     */
    it('records the delivery once, however many confirmations arrive', async () => {
      const { service, proposals, events } = build();
      const proposal = (await service.openFromStrike(strike()))!;
      const first = proposals.rows.get(proposal.id)!.notifiedAt!.getTime();

      await service.markDelivered('org_1', proposal.id, new Date('2026-08-11T10:00:00Z'));
      await service.markDelivered('org_1', proposal.id, new Date('2026-08-12T10:00:00Z'));

      expect(proposals.rows.get(proposal.id)!.notifiedAt!.getTime()).toBe(first);
      expect(events.kinds().filter((k) => k === 'NOTIFIED')).toHaveLength(1);
    });

    /**
     * Business review 5: no clock starts from a delivery. The record's
     * on-chain `executableAt` is the only deadline.
     */
    it('tells the provider the dispute is on chain', async () => {
      const { service, notifications } = build();
      await service.openFromStrike(strike());

      expect(notifications.sent[0].body).toContain(
        'Disputing freezes the penalty on chain until the arbiter decides',
      );
    });
  });

  /**
   * Self-check #2 — *"Test: once the objection deadline passes, the proposal finalises itself."*
   */
  describe('the undisputed sweeper', () => {
    it('upholds an undisputed case at its record’s executableAt, with no outcome', async () => {
      const { service, proposals, events } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        assetId: EVM_ASSET,
        chainStatus: 'PENDING',
        chainExecutableAt: new Date('2026-08-12T09:14:00Z'),
      });

      expect(await service.sweepUndisputed(new Date('2026-08-12T09:13:00Z'))).toBe(0);
      // R2-2: past the door, but a dispute sent just before it may not be
      // confirmed in the watcher's view yet.
      expect(await service.sweepUndisputed(new Date('2026-08-12T09:15:00Z'))).toBe(0);
      expect(await service.sweepUndisputed(new Date('2026-08-12T09:25:00Z'))).toBe(1);
      expect(proposals.rows.get('p1')!).toMatchObject({
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.AUTO_UNDISPUTED,
        countsAsFalsePositive: false,
      });
      expect(events.kinds()).toContain('AUTO_CLOSED');
    });

    it('R2-10: labels the uphold CHAIN_ARBITER when the arbiter already upheld a record of it', async () => {
      const { service, proposals, events } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        assetId: EVM_ASSET,
        chainStatus: 'PENDING',
        chainExecutableAt: new Date('2026-08-12T09:14:00Z'),
      });
      proposals.arbiterUpheld.add('p1');

      expect(await service.sweepUndisputed(new Date('2026-08-12T09:25:00Z'))).toBe(1);
      expect(proposals.rows.get('p1')!).toMatchObject({
        status: SlashProposalStatus.UPHELD,
        resolutionKind: ResolutionKind.CHAIN_ARBITER,
      });
      expect(events.rows.at(-1)!.summary).toContain('arbiter');
    });

    it('never upholds an EVM case whose record is disputed on chain', async () => {
      const { service, proposals } = build();
      proposals.seed({
        id: 'p1',
        organizationId: 'org_1',
        status: SlashProposalStatus.PROPOSED,
        assetId: EVM_ASSET,
        chainStatus: 'DISPUTED',
        chainExecutableAt: new Date('2026-08-12T09:14:00Z'),
      });

      expect(await service.sweepUndisputed(new Date('2030-01-01T00:00:00Z'))).toBe(0);
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
    const legacy = createHash('sha256').update('assay:slash-request:v1').update(ID).digest('hex');

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
