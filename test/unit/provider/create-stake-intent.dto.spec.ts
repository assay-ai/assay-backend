import { ValidationPipe } from '@nestjs/common';

import { CreateStakeIntentBodyDto } from '@modules/provider/dto/create-stake-intent.dto';

/** The stake intent amount, through the same pipe the API installs (BUG-PRV-MONEY-01). */
describe('CreateStakeIntentBodyDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const parse = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: CreateStakeIntentBodyDto });
  const messageOf = async (attempt: Promise<unknown>): Promise<string> => {
    try {
      await attempt;
    } catch (error) {
      const response = (error as { getResponse: () => { message: string[] } }).getResponse();
      return response.message.join('; ');
    }
    throw new Error('expected the body to be refused');
  };

  it.each(['1', '1000000', '262000000', '0100'])('accepts %p', async (amount) => {
    await expect(parse({ amount })).resolves.toMatchObject({ amount });
  });

  it.each(['0', '000'])('refuses %p: amount must be greater than 0', async (amount) => {
    expect(await messageOf(parse({ amount }))).toBe('amount must be greater than 0');
  });

  it.each(['abc', '-5', '1.5', '1e3', ''])('still refuses %p', async (amount) => {
    await expect(parse({ amount })).rejects.toBeDefined();
  });
});
