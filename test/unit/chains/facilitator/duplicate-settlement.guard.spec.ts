import { DuplicateSettlementGuard } from '@modules/chains/facilitator/verification/duplicate-settlement.guard';

describe('DuplicateSettlementGuard', () => {
  it('reserves a payload never seen before', async () => {
    const setWithOptions = jest.fn().mockResolvedValue('OK');
    const guard = new DuplicateSettlementGuard({ setWithOptions } as never);

    expect(await guard.reserve('base64-transaction-a')).toBe(true);
    expect(setWithOptions).toHaveBeenCalledWith(
      expect.stringContaining('facilitator:settle:'),
      '1',
      'EX',
      120,
      'NX',
    );
  });

  it('refuses a payload already in flight — Redis SET NX returned null', async () => {
    const setWithOptions = jest.fn().mockResolvedValue(null);
    const guard = new DuplicateSettlementGuard({ setWithOptions } as never);

    expect(await guard.reserve('base64-transaction-a')).toBe(false);
  });

  it('hashes the transaction into the key rather than embedding raw base64', async () => {
    const setWithOptions = jest.fn().mockResolvedValue('OK');
    const guard = new DuplicateSettlementGuard({ setWithOptions } as never);

    await guard.reserve('a-very-long-base64-transaction-payload-that-should-not-appear-verbatim');

    const [key] = setWithOptions.mock.calls[0];
    expect(key).not.toContain('a-very-long-base64-transaction-payload');
    expect(key).toMatch(/^facilitator:settle:[a-f0-9]{64}$/);
  });

  it('produces the same key for the same payload and different keys for different payloads', async () => {
    const setWithOptions = jest.fn().mockResolvedValue('OK');
    const guard = new DuplicateSettlementGuard({ setWithOptions } as never);

    await guard.reserve('payload-one');
    await guard.reserve('payload-one');
    await guard.reserve('payload-two');

    const keys = setWithOptions.mock.calls.map((call) => call[0]);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toBe(keys[2]);
  });
});
