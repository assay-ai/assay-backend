import {
  ChannelSlashGuard,
  ChannelsSettlingBeforeSlashError,
  SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS,
  slashWaitKey,
} from '@modules/payment/services/channel-slash-guard.service';

const CHAIN = 'eip155:46630';

/** A Redis stand-in shared between guard instances: the wait survives a restart. */
function store() {
  const values = new Map<string, string>();
  return {
    values,
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => void values.set(key, value),
    del: async (key: string) => void values.delete(key),
  };
}

function guard(unsettled: number[], live = true, cache: ReturnType<typeof store> | null = null) {
  let now = 1_800_000_000_000;
  const alerts: unknown[] = [];
  const channels = { requestProviderSettle: jest.fn(async () => unsettled.shift() ?? 0) };
  const make = () =>
    new ChannelSlashGuard(
      channels as never,
      new Set(live ? [CHAIN] : []),
      { emit: async (a: unknown) => void alerts.push(a) } as never,
      cache as never,
      () => now,
    );
  return {
    service: make(),
    restart: make,
    channels,
    alerts,
    advance: (s: number) => (now += s * 1000),
  };
}

const input = { proposalId: 'case-1', providerId: 'provider-1', chainId: CHAIN };

describe('ChannelSlashGuard (v3 §5.4.7: settle before proposeSlash)', () => {
  it('asks for an urgent round and puts the proposal back while channels are unsettled', async () => {
    const h = guard([2]);
    await expect(h.service.beforePropose(input)).rejects.toBeInstanceOf(
      ChannelsSettlingBeforeSlashError,
    );
    expect(h.channels.requestProviderSettle).toHaveBeenCalledWith('provider-1', CHAIN, 'SLASH');
  });

  it('lets the proposal go once nothing is unsettled', async () => {
    const h = guard([1, 0]);
    await expect(h.service.beforePropose(input)).rejects.toThrow();
    await expect(h.service.beforePropose(input)).resolves.toBeUndefined();
  });

  it('never holds compensation back for good: after the maximum wait it proposes and pages', async () => {
    const h = guard([1, 1]);
    await expect(h.service.beforePropose(input)).rejects.toThrow();
    h.advance(SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS);
    await expect(h.service.beforePropose(input)).resolves.toBeUndefined();
    expect(h.alerts).toHaveLength(1);
  });

  it('does nothing on a chain without channels (nothing unsettled there)', async () => {
    const h = guard([0], false);
    await expect(h.service.beforePropose(input)).resolves.toBeUndefined();
  });

  it('final review ops F8: the live flag gates admission only — with it off, unsettled channels still hold the slash', async () => {
    const h = guard([5], false);
    await expect(h.service.beforePropose(input)).rejects.toBeInstanceOf(
      ChannelsSettlingBeforeSlashError,
    );
    expect(h.channels.requestProviderSettle).toHaveBeenCalledWith('provider-1', CHAIN, 'SLASH');
  });

  it('a restart does not start the wait again: the first deferral is in Redis', async () => {
    const cache = store();
    const h = guard([1, 1, 1], true, cache);
    await expect(h.service.beforePropose(input)).rejects.toThrow();
    expect(cache.values.get(slashWaitKey('case-1'))).toBeDefined();
    h.advance(SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS - 60);
    // A new process, the same store: still inside the wait.
    await expect(h.restart().beforePropose(input)).rejects.toThrow();
    h.advance(60);
    await expect(h.restart().beforePropose(input)).resolves.toBeUndefined();
    expect(cache.values.has(slashWaitKey('case-1'))).toBe(false);
  });

  it('falls back to memory when Redis fails', async () => {
    const broken = {
      get: async () => {
        throw new Error('down');
      },
      set: async () => undefined,
      del: async () => undefined,
    };
    const h = guard([1, 1], true, broken as never);
    await expect(h.service.beforePropose(input)).rejects.toThrow();
    h.advance(SLASH_CHANNEL_SETTLE_MAX_WAIT_SECONDS);
    await expect(h.service.beforePropose(input)).resolves.toBeUndefined();
  });
});
