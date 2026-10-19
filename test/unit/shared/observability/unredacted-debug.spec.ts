import { unredactedDebugWarning } from '@shared/observability';

describe('unredactedDebugWarning (review M5)', () => {
  it.each(['ioredis:*', 'ioredis', 'express:*,ioredis:redis', '*'])(
    'warns for DEBUG=%s',
    (debug) => {
      expect(unredactedDebugWarning({ DEBUG: debug })).toContain('unredacted');
    },
  );

  it.each([undefined, '', 'express:*', 'typeorm'])('is silent for DEBUG=%s', (debug) => {
    expect(unredactedDebugWarning({ DEBUG: debug })).toBeNull();
  });
});
