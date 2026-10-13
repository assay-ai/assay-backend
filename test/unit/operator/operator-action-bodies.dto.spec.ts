import { Type, ValidationPipe } from '@nestjs/common';

import {
  CompensatedBodyDto,
  DecideCaseBodyDto,
  ExtendDeadlineBodyDto,
  OpenFleetSweepBodyDto,
  SecondSignatureBodyDto,
  SuspendProposalBodyDto,
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
  const NOTE_120 = 'n'.repeat(120);

  describe('decide', () => {
    const recalculated = (extra: Record<string, unknown>) => ({
      outcome: 'UPHELD_RECALCULATED',
      reasonCodes: ['PRICE_BASIS_WRONG'],
      note: NOTE_120,
      ...extra,
    });

    it.each(['284.7', 'abc', '', '0', '-5', '028470000', ' 100', '1e3', '0x10', '१२'])(
      'refuses recalculatedAmount %p',
      async (recalculatedAmount) => {
        const message = await messageOf(
          parse(DecideCaseBodyDto, recalculated({ recalculatedAmount })),
        );
        expect(message).toContain('recalculatedAmount');
        expect(message).toContain('minor units');
      },
    );

    it.each([28470000, null, ['1']])(
      'refuses a recalculatedAmount that is not a string: %p',
      async (recalculatedAmount) => {
        await expect(
          parse(DecideCaseBodyDto, recalculated({ recalculatedAmount })),
        ).rejects.toBeDefined();
      },
    );

    it('requires recalculatedAmount when the outcome is UPHELD_RECALCULATED', async () => {
      const message = await messageOf(parse(DecideCaseBodyDto, recalculated({})));
      expect(message).toContain('recalculatedAmount');
    });

    it('accepts a positive whole number of minor units', async () => {
      await expect(
        parse(DecideCaseBodyDto, recalculated({ recalculatedAmount: '28470000' })),
      ).resolves.toMatchObject({ recalculatedAmount: '28470000' });
    });

    it('does not ask for an amount on the other outcomes', async () => {
      await expect(
        parse(DecideCaseBodyDto, {
          outcome: 'UPHELD',
          reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
          note: NOTE_120,
        }),
      ).resolves.toMatchObject({ outcome: 'UPHELD' });
    });

    it('still validates an amount sent with another outcome', async () => {
      await expect(
        parse(DecideCaseBodyDto, {
          outcome: 'UPHELD',
          reasonCodes: ['RATE_GENUINELY_EXCEEDED'],
          note: NOTE_120,
          recalculatedAmount: 'abc',
        }),
      ).rejects.toBeDefined();
    });

    it.each([[['']], [['   ']], [['PRICE_BASIS_WRONG', ' ']]])(
      'refuses blank reason codes %p',
      async (reasonCodes) => {
        await expect(
          parse(DecideCaseBodyDto, recalculated({ reasonCodes, recalculatedAmount: '1' })),
        ).rejects.toBeDefined();
      },
    );

    it('counts the note after trimming', async () => {
      await expect(
        parse(DecideCaseBodyDto, recalculated({ note: ' '.repeat(120), recalculatedAmount: '1' })),
      ).rejects.toBeDefined();
      await expect(
        parse(
          DecideCaseBodyDto,
          recalculated({ note: `${'n'.repeat(119)}   `, recalculatedAmount: '1' }),
        ),
      ).rejects.toBeDefined();
    });

    it('trims what it stores and drops blank optional references', async () => {
      await expect(
        parse(
          DecideCaseBodyDto,
          recalculated({
            reasonCodes: [' PRICE_BASIS_WRONG '],
            note: `  ${NOTE_120}  `,
            ticketRef: '   ',
            rootCauseKey: ' mapping/v3 ',
            recalculatedAmount: '1',
          }),
        ),
      ).resolves.toMatchObject({
        reasonCodes: ['PRICE_BASIS_WRONG'],
        note: NOTE_120,
        ticketRef: undefined,
        rootCauseKey: 'mapping/v3',
      });
    });
  });

  describe('reason code and note on every other action', () => {
    const bodies: [string, Type<object>, Record<string, unknown>, number][] = [
      ['suspend', SuspendProposalBodyDto, {}, 20],
      ['extend-deadline', ExtendDeadlineBodyDto, { additionalHours: 2 }, 20],
      ['sweep', OpenFleetSweepBodyDto, { defectKey: 'mapping/v3', lookbackHours: 24 }, 120],
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

    it('refuses a blank sweep defect key', async () => {
      await expect(
        parse(OpenFleetSweepBodyDto, {
          defectKey: '   ',
          lookbackHours: 24,
          reasonCode: 'MAPPING_REGRESSION',
          note: NOTE_120,
        }),
      ).rejects.toBeDefined();
    });

    it('drops a blank ticket reference instead of recording an empty one', async () => {
      await expect(
        parse(SuspendProposalBodyDto, {
          reasonCode: 'OPERATOR_HOLD',
          note: NOTE_20,
          ticketRef: ' ',
        }),
      ).resolves.toMatchObject({ ticketRef: undefined });
    });
  });

  describe('second signature', () => {
    it('refuses a note made of spaces', async () => {
      await expect(
        parse(SecondSignatureBodyDto, { kind: 'SIGNED', note: ' '.repeat(20) }),
      ).rejects.toBeDefined();
    });

    it('accepts a real note', async () => {
      await expect(
        parse(SecondSignatureBodyDto, { kind: 'OBJECTED', note: ` ${NOTE_20} ` }),
      ).resolves.toMatchObject({ note: NOTE_20 });
    });
  });
});
