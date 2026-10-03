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

export function solanaConfig(): { keypairPath: string; rpcUrl: string } {
  const output = execFileSync('solana', ['config', 'get'], { encoding: 'utf8' });
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
  const output = execFileSync('spl-token', [...args, '--output', 'json'], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(output);
}

export function solanaBalanceSol(pubkey: string): number {
  const output = execFileSync('solana', ['balance', pubkey], { encoding: 'utf8' });
  const match = /^([\d.]+)\s+SOL/.exec(output.trim());
  return match ? Number(match[1]) : 0;
}
