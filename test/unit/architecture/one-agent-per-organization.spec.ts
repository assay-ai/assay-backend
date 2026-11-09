import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * One agent per organization (review W-I1, 2026-11-08).
 *
 * Several agent-credential routes (`/tool-calls`, `/verdicts/:id/evidence`,
 * `/receipts`, `/holds`, `/balances`, `/call-disputes`) scope reads and writes
 * to the ORGANIZATION, not the agent, and their tenant cache varies by org.
 * That is only safe while every organization has exactly one agent: the
 * organization and its agent are created together, in one transaction, by
 * `AgentRepository.createWithOrganization`, and nothing else creates an agent.
 *
 * DO NOT relax this test to allow a second creation path (a `POST /agents`, an
 * "add agent" service, a raw insert) until the per-agent scoping of agent API
 * keys has landed: pass an owner scope (like `depositOwnerScope`) into those
 * services and switch their cache `vary` to `'agent'`. Otherwise agent A's key
 * can read agent B's call evidence and file or withdraw B's disputes.
 */
const ROOT = join(__dirname, '../../..');
const SRC = join(ROOT, 'src');
const AGENT_REPOSITORY = join(SRC, 'database/postgres/repositories/agent.repository.ts');
const AGENTS_CONTROLLER = join(SRC, 'modules/account/controllers/agents.controller.ts');
const MIGRATIONS = join(SRC, 'database/postgres/migrations');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
  });
}

const sources = walk(SRC)
  .filter((path) => !path.startsWith(MIGRATIONS))
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }));

describe('one agent per organization (W-I1)', () => {
  it('only AgentRepository.createWithOrganization creates an agent row', () => {
    const creators =
      /\b(?:create|insert|save|upsert)\(\s*AgentEntity\b|getRepository\(\s*AgentEntity\s*\)\s*\.\s*(?:insert|save|upsert)\b|INSERT\s+INTO\s+"?agents"?\b/i;
    const offenders = sources
      .filter(({ path, text }) => path !== AGENT_REPOSITORY && creators.test(text))
      .map(({ path }) => relative(ROOT, path));
    expect(offenders).toEqual([]);

    const repository = readFileSync(AGENT_REPOSITORY, 'utf8');
    const creates = repository.match(/create\(\s*AgentEntity\b/g) ?? [];
    expect(creates).toHaveLength(1);
    // That one creation sits inside `createWithOrganization`, next to the
    // organization it is created with, in the same transaction.
    const body = repository.slice(repository.indexOf('async createWithOrganization('));
    const method = body.slice(0, body.indexOf('\n  }\n') + 4);
    expect(method).toMatch(/dataSource\.transaction\(/);
    expect(method).toMatch(/create\(\s*OrganizationEntity\b/);
    expect(method).toMatch(/create\(\s*AgentEntity\b/);
    // No other write method on the repository inserts or saves agents.
    expect(repository.replace(method, '')).not.toMatch(/\.(?:insert|save|upsert)\(/);
  });

  it('createWithOrganization has the single provisioning caller', () => {
    const callers = sources
      .filter(
        ({ path, text }) => path !== AGENT_REPOSITORY && /\.createWithOrganization\(/.test(text),
      )
      .map(({ path }) => relative(SRC, path));
    expect(callers).toEqual(['modules/auth/services/agent-provisioning.service.ts']);
  });

  it('the agents API has no route that creates an agent', () => {
    const controller = readFileSync(AGENTS_CONTROLLER, 'utf8');
    expect(controller).not.toMatch(/@(?:Post|Put)\(/);
  });
});
