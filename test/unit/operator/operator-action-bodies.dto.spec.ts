import { Type, ValidationPipe } from '@nestjs/common';

import {
  CompensatedBodyDto,
  ManualCaseActionBodyDto,
  VerifyProviderBodyDto,
} from '@modules/operator/dto/operator-console.dto';

/**
 * The bodies of the operator actions, through the same pipe the API installs.
 *
 * Every one of these is written to the override register and most of them
 * decide money, so what the pipe lets through is what gets recorded: a blank
 * reason code or a note made of spaces must stop here, and a penalty that is
 * not a positive whole number of minor units must never reach `BigInt()`.
 */
describe('operator action bodies', () => {
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

  const NOTE_20 = 'held for the incident';

  describe('reason code and note on every action', () => {
    const bodies: [string, Type<object>, Record<string, unknown>, number][] = [
      ['manual case action', ManualCaseActionBodyDto, {}, 20],
      ['compensated', CompensatedBodyDto, { signature: 's'.repeat(88) }, 20],
      [
        'verify-provider',
        VerifyProviderBodyDto,
        { verified: true, method: 'MANUAL_REVIEW', checks: [{ check: 'kyb', result: 'PASS' }] },
        120,
      ],
    ];

    describe.each(bodies)('%s', (_name, metatype, base, noteMin) => {
      const valid = { ...base, reasonCode: 'OPERATOR_HOLD', note: 'n'.repeat(noteMin) };

      it('accepts a real reason code and note, trimmed', async () => {
        await expect(
          parse(metatype, { ...valid, reasonCode: ' OPERATOR_HOLD ', note: ` ${valid.note} ` }),
        ).resolves.toMatchObject({ reasonCode: 'OPERATOR_HOLD', note: valid.note });
      });

      it.each(['', '   ', '\t\n'])('refuses the reason code %p', async (reasonCode) => {
        const message = await messageOf(parse(metatype, { ...valid, reasonCode }));
        expect(message).toContain('reasonCode');
      });

      it('refuses a missing reason code', async () => {
        await expect(parse(metatype, { ...base, note: 'n'.repeat(noteMin) })).rejects.toBeDefined();
      });

      it('refuses a note made of spaces, or one padded up to the minimum', async () => {
        await expect(
          parse(metatype, { ...valid, note: ' '.repeat(noteMin) }),
        ).rejects.toBeDefined();
        await expect(
          parse(metatype, { ...valid, note: `${'n'.repeat(noteMin - 1)}    ` }),
        ).rejects.toBeDefined();
      });
    });

    it('drops a blank ticket reference instead of recording an empty one', async () => {
      await expect(
        parse(ManualCaseActionBodyDto, {
          reasonCode: 'OPERATOR_HOLD',
          note: NOTE_20,
          ticketRef: ' ',
        }),
      ).resolves.toMatchObject({ ticketRef: undefined });
    });
  });
});
