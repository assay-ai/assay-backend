import { registerQueueOnBoard } from '@shared/queue';

describe('registerQueueOnBoard', () => {
  const saved = process.env.BULLBOARD_ENABLED;

  afterEach(() => {
    if (saved === undefined) delete process.env.BULLBOARD_ENABLED;
    else process.env.BULLBOARD_ENABLED = saved;
  });

  it('contributes nothing when the board is disabled, so the api can boot without its root', () => {
    process.env.BULLBOARD_ENABLED = 'false';

    const module = registerQueueOnBoard('demo.ping');

    expect(module.providers ?? []).toEqual([]);
    expect(module.imports ?? []).toEqual([]);
  });

  it('registers the queue on the board when it is enabled', () => {
    process.env.BULLBOARD_ENABLED = 'true';

    const module = registerQueueOnBoard('demo.ping');

    expect(module.module.name).toBe('BullBoardFeatureModule');
  });
});
