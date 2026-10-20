import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AgentsController } from '@modules/account/controllers/agents.controller';
import { AGENT_LABEL_MAX_LENGTH, UpdateAgentBodyDto } from '@modules/account/dto/update-agent.dto';
import { HumanSessionGuard, SessionAuthGuard } from '@shared/auth';

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(UpdateAgentBodyDto, body);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors };
}

describe('UpdateAgentBodyDto — PATCH /agents/:agentId', () => {
  it('trims the label', async () => {
    const { dto, errors } = await check({ label: '  Research bot  ' });
    expect(errors).toEqual([]);
    expect(dto.label).toBe('Research bot');
  });

  it('accepts letters from any script, digits, spaces and punctuation', async () => {
    const { errors } = await check({ label: "Mia's agent (laptop) #2 — Zoë" });
    expect(errors).toEqual([]);
  });

  it.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['too long', 'a'.repeat(AGENT_LABEL_MAX_LENGTH + 1)],
    ['a newline', 'line one\nline two'],
    ['a tab', 'a\tb'],
    ['a NUL', 'a\u0000b'],
    ['DEL', 'a\u007fb'],
    ['a C1 control', 'a\u0085b'],
    ['a bidi override', 'agent\u202Etxt.exe'],
    ['a zero-width joiner', 'a\u200Db'],
    ['a line separator', 'a\u2028b'],
    ['only a Hangul filler', '\u3164'],
    ['only halfwidth Hangul fillers', '\uFFA0\uFFA0'],
    ['only a Braille blank', '\u2800\u2800'],
    ['only a combining grapheme joiner', '\u034F'],
    ['only combining marks', '\u0301\u0302'],
    ['not a string', 42],
  ])('refuses %s', async (_name, label) => {
    const { errors } = await check({ label });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts exactly the maximum length', async () => {
    const { errors } = await check({ label: 'a'.repeat(AGENT_LABEL_MAX_LENGTH) });
    expect(errors).toEqual([]);
  });

  it('refuses any other field: a rename changes nothing else', async () => {
    const { errors } = await check({ label: 'ok', status: 'ACTIVE' });
    expect(errors.length).toBeGreaterThan(0);
  });

  it('refuses a missing label', async () => {
    const { errors } = await check({});
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('AgentsController.rename — a person act', () => {
  const handler = AgentsController.prototype.rename;

  it('is PATCH /agents/:agentId', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AgentsController)).toBe('agents');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':agentId');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.PATCH);
  });

  it('needs a session and refuses an agent machine credential', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentsController)).toContain(SessionAuthGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toContain(HumanSessionGuard);
  });
});
