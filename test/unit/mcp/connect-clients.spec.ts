import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CONNECT_CLIENTS, RecordConnectUrlBodyDto } from '@modules/mcp/dto/mcp-urls.dto';

/** The Connect sheet's client ids, one list with `assay-mcp add --client` (§7.10 item 5). */
describe('CONNECT_CLIENTS', () => {
  it('is the spec list, in order', () => {
    expect(CONNECT_CLIENTS).toEqual([
      'claude-code',
      'codex',
      'cursor',
      'vscode',
      'windsurf',
      'gemini',
      'claude-desktop',
      'claude-ai',
      'chatgpt',
      'other',
    ]);
  });

  it('every id fits agent_connect_urls.client (varchar(24))', () => {
    for (const id of CONNECT_CLIENTS) expect(id.length).toBeLessThanOrEqual(24);
  });

  const errorsFor = (client: string) =>
    validate(
      plainToInstance(RecordConnectUrlBodyDto, {
        url: 'https://mcp.goassay.ai/',
        client,
      }),
    );

  it.each(CONNECT_CLIENTS)('the record body accepts %s', async (client) => {
    expect(await errorsFor(client)).toEqual([]);
  });

  it('the record body refuses an unknown client', async () => {
    const errors = await errorsFor('claude');
    expect(errors.map((error) => error.property)).toEqual(['client']);
  });
});
