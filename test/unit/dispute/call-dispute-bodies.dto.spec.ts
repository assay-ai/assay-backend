import { Type, ValidationPipe } from '@nestjs/common';

import { RespondCallDisputeBodyDto } from '@modules/dispute/dto/call-dispute.dto';

/** The provider's reply, through the same pipe the API installs (BUG-PRV-DISPUTES-01). */
describe('RespondCallDisputeBodyDto', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const parse = <T>(metatype: Type<T>, body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype }) as Promise<T>;
  const messageOf = async (attempt: Promise<unknown>): Promise<string> => {
    try {
      await attempt;
    } catch (error) {
      const response = (error as { getResponse: () => { message: string[] } }).getResponse();
      return response.message.join('; ');
    }
    throw new Error('expected the body to be refused');
  };

  it.each(['abc', 'We refunded it.', 'x'.repeat(1000)])('accepts %p', async (response) => {
    await expect(parse(RespondCallDisputeBodyDto, { response })).resolves.toMatchObject({
      response,
    });
  });

  it('trims the reply before checking it', async () => {
    await expect(parse(RespondCallDisputeBodyDto, { response: '  done  ' })).resolves.toMatchObject(
      { response: 'done' },
    );
  });

  it.each(['a', 'ab', '  ab  '])('refuses %p: under 3 characters', async (response) => {
    const message = await messageOf(parse(RespondCallDisputeBodyDto, { response }));
    expect(message).toContain('The reply must be at least 3 characters');
  });

  it.each(['', '   ', 'x'.repeat(1001)])('still refuses %p', async (response) => {
    await expect(parse(RespondCallDisputeBodyDto, { response })).rejects.toBeDefined();
  });
});
