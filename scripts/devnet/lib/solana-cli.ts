/**
 * Thin wrappers around the `solana` / `spl-token` CLIs.
 *
 * The mint and its funding are the one part of this script where shelling
 * out beats hand-building instructions: `spl-token`'s `--output json` gives
 * a stable, parseable result for "create this mint / account / minted
 * amount", and the CLI is already configured (devnet RPC, a funded default
 * keypair) in this environment — duplicating that configuration logic in
 * TypeScript would be the less reliable path, not the more principled one.
 * The Squads multisig and the deposit payload itself are still built
 * programmatically (`squads-setup.ts`, `build-deposit-payload.ts`) because
 * no CLI exists for either.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export type SolanaBinary = 'solana' | 'spl-token' | 'solana-keygen';

/**
 * Absolute path of a Solana CLI binary, resolved without consulting `PATH`.
 *
 * These scripts hold keypairs and sign real transactions, so a `solana` that
 * resolves to whatever is first on `PATH` — a writable `./node_modules/.bin`,
 * a stray directory a tool prepended — would run with that keypair in reach.
 * The binary is looked up instead in `SOLANA_BIN_DIR` when set (it must be
 * absolute), otherwise in the installer's default location followed by the
 * system package-manager directories.
 */
export function solanaBin(name: SolanaBinary): string {
  const override = process.env.SOLANA_BIN_DIR;
  if (override !== undefined && !isAbsolute(override)) {
    throw new Error(`SOLANA_BIN_DIR must be an absolute path, got: ${override}`);
  }
  const dirs = override
    ? [override]
    : [
        join(homedir(), '.local/share/solana/install/active_release/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
      ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `\`${name}\` not found in ${dirs.join(', ')}. ` +
      'Set SOLANA_BIN_DIR to the absolute directory that holds the Solana CLI.',
  );
}

export function solanaConfig(): { keypairPath: string; rpcUrl: string } {
  const output = execFileSync(solanaBin('solana'), ['config', 'get'], { encoding: 'utf8' });
  const keypairPath = matchLine(output, /Keypair Path:\s*(\S+)/);
  const rpcUrl = matchLine(output, /RPC URL:\s*(\S+)/);
  if (!keypairPath || !rpcUrl) {
    throw new Error(`Could not parse \`solana config get\` output:\n${output}`);
  }
  return { keypairPath, rpcUrl };
}

function matchLine(output: string, pattern: RegExp): string | null {
  const match = pattern.exec(output);
  return match ? match[1] : null;
}

export function splToken(args: readonly string[]): unknown {
  const output = execFileSync(solanaBin('spl-token'), [...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function solanaBalanceSol(pubkey: string): number {
  const output = execFileSync(solanaBin('solana'), ['balance', pubkey], { encoding: 'utf8' });
  const match = /^([\d.]+)\s+SOL/.exec(output.trim());
  return match ? Number(match[1]) : 0;
}
