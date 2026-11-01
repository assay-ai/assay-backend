import { GUARDS_METADATA } from '@nestjs/common/constants';

import { EMPTY_SLOT } from '@modules/payment/domain/channel/channel-voucher';
import { OperatorProvidersController } from '@modules/operator/controllers/operator-providers.controller';
import { OVERRIDE_REGISTER } from '@modules/operator/domain/override-register';
import { OperatorOverrideGuard } from '@modules/operator/guards/operator-override.guard';
import { OperatorChannelDrainService } from '@modules/operator/services/operator-channel-drain.service';
import { OperatorAuthGuard, OperatorRolesGuard } from '@shared/auth';

import { expectErrorCodeAsync } from '../helpers/expect-error-code';

/**
 * Final review 2026-11-01 backend F1 / ops F3: a lane the reconciler stopped
 * (DESYNC/RECONCILE) had no exit. Override `M-4` clears it after an
 * investigation, back to ROTATED (existing value settles, no new vouchers),
 * audited in the override register, and only while the chain agrees again.
 */
const ASSET = 'eip155:46630/erc20:0x7E99c98e066032b2Ef5768ff18Ed090e1aB921ac';
const LANE = '6f0b3c8e-4a52-4c1e-9d55-2b9a5f0f7a11';
const KEY = `0x${'0c'.repeat(32)}`;

function build(options: {
  lane?: Record<string, unknown> | null;
  chainSettled?: bigint;
  cleared?: boolean;
  door?: boolean;
}) {
  const lane =
    options.lane === null
      ? null
      : {
          id: LANE,
          assetId: ASSET,
          channelKey: KEY,
          status: 'DESYNC',
          statusReason: 'RECONCILE',
          lastAcceptedCumulative: '500',
          settledCumulative: '300',
          ...options.lane,
        };
  const clearReconcile = jest.fn(async () => options.cleared ?? true);
  const perform = jest.fn(
    async (
      _context: unknown,
      mutation: (qr: unknown) => Promise<{ value: unknown; before: unknown; after: unknown }>,
    ) => (await mutation({ manager: 'tx' })).value,
  );
  const door = {
    readBooks: jest.fn(async () => ({
      slot: { ...EMPTY_SLOT, settled: options.chainSettled ?? 300n },
      unpaid: 0n,
      totalUnpaid: 0n,
      held: 0n,
    })),
  };
  const service = new OperatorChannelDrainService(
    { perform } as never,
    { findById: async () => lane, clearReconcile } as never,
    options.door === false ? null : (door as never),
  );
  return { service, perform, clearReconcile, door };
}

const input = {
  channelRowId: LANE,
  reasonCode: 'RECONCILE_INVESTIGATED',
  note: 'lagging node read, chain agrees now',
};

describe('Override M-4: clear a reconciler stop (DESYNC/RECONCILE)', () => {
  it('is registered: money family, one operator, SRE or TRE', () => {
    expect(OVERRIDE_REGISTER['M-4']).toMatchObject({
      code: 'M-4',
      action: 'channels.reconcile_cleared',
      approval: 'SINGLE',
      implemented: true,
    });
    expect(OVERRIDE_REGISTER['M-4'].roles).toEqual(expect.arrayContaining(['SRE', 'TRE']));
  });

  it('clears a RECONCILE lane back to ROTATED inside the audited override', async () => {
    const { service, perform, clearReconcile, door } = build({});
    const result = await service.clearReconcile({ operatorId: 'op' } as never, input, 'req-1');
    expect(result).toEqual({ channelRowId: LANE, status: 'ROTATED' });
    expect(door.readBooks).toHaveBeenCalledWith(ASSET, KEY);
    expect(clearReconcile).toHaveBeenCalledWith('tx', LANE);
    expect(perform.mock.calls[0][0]).toMatchObject({
      code: 'M-4',
      targetType: 'voucher_channel',
      targetId: LANE,
      organizationId: null,
      reasonCode: 'RECONCILE_INVESTIGATED',
      requestId: 'req-1',
    });
  });

  it.each([
    ['an OPEN lane', { status: 'OPEN', statusReason: null }],
    ['a DESYNC lane stopped for another reason', { status: 'DESYNC', statusReason: 'CONTINUITY' }],
    ['a CLOSED lane', { status: 'CLOSED', statusReason: 'RECONCILE' }],
  ])('refuses %s', async (_name, lane) => {
    const { service, perform } = build({ lane });
    await expectErrorCodeAsync(
      () => service.clearReconcile({ operatorId: 'op' } as never, input, null),
      'OPERATOR_CHANNEL_CLEAR_REFUSED',
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it('refuses an unknown lane', async () => {
    const { service } = build({ lane: null });
    await expectErrorCodeAsync(
      () => service.clearReconcile({ operatorId: 'op' } as never, input, null),
      'OPERATOR_CHANNEL_CLEAR_REFUSED',
    );
  });

  it.each([
    ['above what was accepted', 600n],
    ['behind what was booked', 200n],
  ])('refuses while the chain still disagrees (%s)', async (_name, chainSettled) => {
    const { service, perform } = build({ chainSettled });
    await expectErrorCodeAsync(
      () => service.clearReconcile({ operatorId: 'op' } as never, input, null),
      'OPERATOR_CHANNEL_CLEAR_REFUSED',
    );
    expect(perform).not.toHaveBeenCalled();
  });

  it('refuses when the lane changed meanwhile (compare-and-set lost)', async () => {
    const { service } = build({ cleared: false });
    await expectErrorCodeAsync(
      () => service.clearReconcile({ operatorId: 'op' } as never, input, null),
      'OPERATOR_CHANNEL_CLEAR_REFUSED',
    );
  });

  it('the route sits behind the operator auth, roles and override guards, SRE or TRE', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, OperatorProvidersController) as unknown[];
    expect(guards).toEqual([OperatorAuthGuard, OperatorRolesGuard, OperatorOverrideGuard]);
    const handler = OperatorProvidersController.prototype.clearReconcile;
    expect(handler).toBeDefined();
    const metadataKeys = Reflect.getMetadataKeys(handler) as string[];
    const values = Object.fromEntries(
      metadataKeys.map((k) => [k, Reflect.getMetadata(k, handler)]),
    );
    expect(Object.values(values)).toEqual(expect.arrayContaining(['M-4', ['SRE', 'TRE']]));
    expect(values.path).toBe('channels/clear-reconcile');
  });
});

describe('GET /operator/channels/stopped: the reconciler stops to investigate', () => {
  const stoppedLane = {
    id: LANE,
    channelKey: KEY,
    chainId: 'eip155:46630',
    assetId: ASSET,
    providerId: '28e57af8-0000-4000-8000-000000000001',
    payer: 'eip155:46630:0x1111111111111111111111111111111111111111',
    status: 'DESYNC',
    statusReason: 'RECONCILE',
    lastAcceptedCumulative: '500',
    settledCumulative: '300',
    updatedAt: new Date('2026-11-01T14:10:00Z'),
  };

  it('lists each stopped lane with the channelRowId the clear override takes', async () => {
    const listReconcileStopped = jest.fn(async () => [stoppedLane]);
    const service = new OperatorChannelDrainService(
      { perform: jest.fn() } as never,
      { listReconcileStopped } as never,
      null,
    );

    expect(await service.listStopped()).toEqual({
      truncated: false,
      items: [
        {
          channelRowId: LANE,
          channelKey: KEY,
          chainId: 'eip155:46630',
          assetId: ASSET,
          providerId: stoppedLane.providerId,
          payer: stoppedLane.payer,
          lastUpdatedAt: '2026-11-01T14:10:00.000Z',
          reason: 'RECONCILE',
          accepted: '500',
          settled: '300',
        },
      ],
    });
    // One more than the cap, to tell a cut list from a full one.
    expect(listReconcileStopped).toHaveBeenCalledWith(201);
  });

  it('says truncated when more lanes are stopped than the cap', async () => {
    const lanes = Array.from({ length: 4 }, (_, index) => ({
      ...stoppedLane,
      id: `lane-${index}`,
    }));
    const listReconcileStopped = jest.fn(async (limit: number) => lanes.slice(0, limit));
    const service = new OperatorChannelDrainService(
      { perform: jest.fn() } as never,
      { listReconcileStopped } as never,
      null,
    );

    const cut = await service.listStopped(3);
    expect(cut.truncated).toBe(true);
    expect(cut.items.map((item) => item.channelRowId)).toEqual(['lane-0', 'lane-1', 'lane-2']);
    const whole = await service.listStopped(4);
    expect(whole.truncated).toBe(false);
    expect(whole.items).toHaveLength(4);
  });

  it('is a read: SRE, TRE or OPS_ADMIN, no override', async () => {
    const handler = OperatorProvidersController.prototype.stoppedChannels;
    expect(handler).toBeDefined();
    const values = Object.fromEntries(
      (Reflect.getMetadataKeys(handler) as string[]).map((k) => [
        k,
        Reflect.getMetadata(k, handler),
      ]),
    );
    expect(values.path).toBe('channels/stopped');
    expect(values.method).toBe(0); // RequestMethod.GET
    expect(Object.values(values)).toEqual(expect.arrayContaining([['SRE', 'TRE', 'OPS_ADMIN']]));
    expect(Object.values(values)).not.toContain('M-4');

    const listStopped = jest.fn(async () => ({ items: [], truncated: false }));
    const controller = new OperatorProvidersController({} as never, undefined, undefined, {
      listStopped,
    } as never);
    await expect(controller.stoppedChannels()).resolves.toEqual({ items: [], truncated: false });
  });
});
