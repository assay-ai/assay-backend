import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateAgentCredentialBodyDto } from '@modules/account/dto/create-agent-credential.dto';

async function errorsOf(body: Record<string, unknown>) {
  const dto = plainToInstance(CreateAgentCredentialBodyDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return errors.map((error) => error.property);
}

/** `POST /agents/:agentId/credentials` — the scope vocabulary is closed. */
describe('CreateAgentCredentialBodyDto — scopes and expiry', () => {
  it('accepts no scopes at all (the service applies the default)', async () => {
    expect(await errorsOf({ name: 'agent' })).toEqual([]);
  });

  it('accepts every scope of the vocabulary', async () => {
    expect(
      await errorsOf({
        name: 'agent',
        scopes: ['tools:call', 'payments', 'activity:read', 'reports:write'],
      }),
    ).toEqual([]);
  });

  it.each([
    ['an unknown scope', ['tools:call', 'admin']],
    ['a provider scope (not offered)', ['provider:read']],
    ['an empty list', []],
    ['a repeated scope', ['tools:call', 'tools:call']],
    ['not a list', 'tools:call'],
  ])('refuses %s', async (_label, scopes) => {
    expect(await errorsOf({ name: 'agent', scopes })).toEqual(['scopes']);
  });

  it('refuses an expiry that is not a date', async () => {
    expect(await errorsOf({ name: 'agent', expiresAt: 'never' })).toEqual(['expiresAt']);
  });
});
