import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { RecordConnectUrlBodyDto } from '@modules/mcp/dto/mcp-urls.dto';

const check = async (serverName: unknown) =>
  validate(
    plainToInstance(RecordConnectUrlBodyDto, { url: 'https://mcp.example.test/', serverName }),
  );

describe('RecordConnectUrlBodyDto serverName (spec 8.3.1)', () => {
  it('accepts a 56-character name', async () => {
    expect(await check('a'.repeat(56))).toHaveLength(0);
  });

  it('accepts the defaults and a dashed name', async () => {
    expect(await check('assay')).toHaveLength(0);
    expect(await check('assay-twitter-kit')).toHaveLength(0);
  });

  it('refuses a 57-character name', async () => {
    expect(await check('a'.repeat(57))).toHaveLength(1);
  });

  it.each(['_', 'assay_weather', 'Assay', '1assay', '-assay', '', 'a b', 'assay\n'])(
    'refuses %j',
    async (name) => {
      expect(await check(name)).toHaveLength(1);
    },
  );

  it('is optional', async () => {
    expect(await check(undefined)).toHaveLength(0);
  });
});
