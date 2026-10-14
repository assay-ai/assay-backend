import { OperatorEntity } from '@database/postgres/entities/operator.entity';
import { OperatorRole } from '@modules/operator/domain/override-register';

/**
 * The operator CLI's logic, apart from its database connection so it can be
 * tested with an in-memory repository.
 *
 *     yarn operator:add --wallet 0x… --subject dan@ --roles ADJL,SRE [--limit 1000000|unbounded]
 *                       [--display-name "Dan"] [--email dan@example.com]
 *     yarn operator:list
 *     yarn operator:remove --wallet 0x… | --subject dan@ | --id <uuid>
 *
 * This is how the first operators exist: running it needs the database, which
 * is already privileged. The console's own directory (`A-12`…`A-14`) takes
 * over from there, with its two-person approvals and register entries. A CLI
 * change writes no register entry — there is no operator to attribute it to —
 * and is picked up by every API instance within a few seconds (the guard
 * re-reads the row on every request, cached briefly).
 */
export interface OperatorCliRepository {
  findByWallet(address: string): Promise<OperatorEntity | null>;
  findBySubject(subject: string): Promise<OperatorEntity | null>;
  findById(id: string): Promise<OperatorEntity | null>;
  listAll(): Promise<OperatorEntity[]>;
  create(values: Partial<OperatorEntity>): OperatorEntity;
  save(entity: OperatorEntity): Promise<OperatorEntity>;
}

export class OperatorCliError extends Error {}

const WALLET = /^0x[0-9a-fA-F]{40}$/;
const MINOR_UNITS = /^(0|[1-9][0-9]{0,77})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new OperatorCliError(`unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split('=', 2);
    const value = inline ?? argv[i + 1];
    if (inline === undefined) i += 1;
    if (value === undefined || value.startsWith('--')) {
      throw new OperatorCliError(`--${name} needs a value`);
    }
    flags[name] = value;
  }
  return flags;
}

function parseRoles(raw: string | undefined): OperatorRole[] {
  if (!raw) throw new OperatorCliError('--roles is required, e.g. --roles ADJL,SRE');
  const known = new Set<string>(Object.values(OperatorRole));
  const roles = [...new Set(raw.split(',').map((role) => role.trim().toUpperCase()))].filter(
    Boolean,
  );
  const unknown = roles.filter((role) => !known.has(role));
  if (unknown.length > 0) {
    throw new OperatorCliError(
      `unknown role(s): ${unknown.join(', ')} — one of ${[...known].join(', ')}`,
    );
  }
  return roles as OperatorRole[];
}

function parseLimit(raw: string | undefined): string | null {
  if (raw === undefined) return '0';
  if (raw === 'unbounded') return null;
  if (!MINOR_UNITS.test(raw)) {
    throw new OperatorCliError('--limit is minor units of the platform asset, or "unbounded"');
  }
  return raw;
}

function parseWallet(raw: string | undefined): string {
  if (!raw || !WALLET.test(raw)) {
    throw new OperatorCliError('--wallet must be a 0x-prefixed 20-byte EVM address');
  }
  return raw.toLowerCase();
}

export function describeOperator(operator: OperatorEntity): string {
  const limit = operator.authorityLimitMinor === null ? 'unbounded' : operator.authorityLimitMinor;
  return (
    `${operator.id}  ${operator.subject}  ${operator.walletAddress ?? '(no wallet)'}  ` +
    `roles=${operator.roles.join(',') || '(none)'}  limit=${limit}  ${operator.status}`
  );
}

export async function addOperator(
  repo: OperatorCliRepository,
  flags: Record<string, string>,
): Promise<{ operator: OperatorEntity; outcome: 'added' | 'linked' | 'restored' }> {
  const walletAddress = parseWallet(flags.wallet);
  const subject = flags.subject?.trim();
  if (!subject) throw new OperatorCliError('--subject is required, e.g. --subject dan@');
  const roles = parseRoles(flags.roles);
  const authorityLimitMinor = parseLimit(flags.limit);

  const byWallet = await repo.findByWallet(walletAddress);
  const bySubject = await repo.findBySubject(subject);

  if (byWallet && byWallet.status !== 'REMOVED') {
    throw new OperatorCliError(`wallet ${walletAddress} is already operator ${byWallet.subject}`);
  }
  if (bySubject && byWallet && bySubject.id !== byWallet.id) {
    throw new OperatorCliError(`subject ${subject} belongs to another operator`);
  }
  if (bySubject && !byWallet && bySubject.walletAddress) {
    throw new OperatorCliError(
      `subject ${subject} is already linked to ${bySubject.walletAddress}`,
    );
  }

  // A row from before wallet sign-in (no wallet yet), a removed operator
  // coming back, or a new one.
  const existing = byWallet ?? bySubject;
  const outcome = byWallet ? 'restored' : bySubject ? 'linked' : 'added';
  const entity =
    existing ??
    repo.create({
      subject,
      displayName: flags['display-name'] ?? subject,
      email: flags.email ?? '',
    });
  Object.assign(entity, {
    subject,
    walletAddress,
    roles,
    authorityLimitMinor,
    status: 'ACTIVE',
    suspendedAt: null,
    removedAt: null,
    ...(flags['display-name'] ? { displayName: flags['display-name'] } : {}),
    ...(flags.email ? { email: flags.email } : {}),
  });
  return { operator: await repo.save(entity), outcome };
}

export async function removeOperator(
  repo: OperatorCliRepository,
  flags: Record<string, string>,
): Promise<OperatorEntity> {
  let operator: OperatorEntity | null = null;
  if (flags.wallet) operator = await repo.findByWallet(parseWallet(flags.wallet));
  else if (flags.subject) operator = await repo.findBySubject(flags.subject);
  else if (flags.id && UUID.test(flags.id)) operator = await repo.findById(flags.id);
  else throw new OperatorCliError('name the operator with --wallet, --subject or --id');

  if (!operator) throw new OperatorCliError('no such operator');
  if (operator.status === 'REMOVED') return operator;
  Object.assign(operator, { status: 'REMOVED', removedAt: new Date(), suspendedAt: null });
  return repo.save(operator);
}

export async function runOperatorCli(
  repo: OperatorCliRepository,
  command: string | undefined,
  argv: readonly string[],
  print: (line: string) => void,
): Promise<void> {
  const flags = parseFlags(argv);
  switch (command) {
    case 'add': {
      const { operator, outcome } = await addOperator(repo, flags);
      print(`${outcome}: ${describeOperator(operator)}`);
      return;
    }
    case 'list': {
      const all = await repo.listAll();
      if (all.length === 0) print('no operators');
      for (const operator of all) print(describeOperator(operator));
      return;
    }
    case 'remove': {
      print(`removed: ${describeOperator(await removeOperator(repo, flags))}`);
      return;
    }
    default:
      throw new OperatorCliError('usage: operators.ts add|list|remove [flags]');
  }
}
