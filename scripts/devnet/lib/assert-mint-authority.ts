/**
 * Refuses to proceed with a devnet mint before `spl-token mint` would.
 *
 * `setupDevnetMint` (`scripts/devnet/lib/mint-setup.ts`) mints with whatever
 * keypair the `solana` CLI is currently configured with, and never checks
 * that key is actually the mint's authority. When it is not, `spl-token`
 * dies with an opaque CLI-layer error. This checks first, on-chain, and
 * refuses with a sentence a human can act on — same pattern as the admin-key
 * gate in `scripts/devnet/create-treasury-vault.ts` (around lines 296-312).
 */
import { PublicKey, type Connection } from '@solana/web3.js';

interface ParsedMintInfo {
  readonly mintAuthority: string | null;
}

interface ParsedAccountData {
  readonly program?: string;
  readonly parsed?: {
    readonly type?: string;
    readonly info?: ParsedMintInfo;
  };
}

/**
 * Throws unless `signer` is the on-chain mint authority of `mint`.
 * `keypairPath` is carried only so the error can tell the reader which file
 * to point `solana config set --keypair` at instead.
 *
 * `new PublicKey` is deliberately not guarded: a mint address that is not
 * base58 is a caller bug, and its own error names the offending value. An
 * earlier version caught it and passed the raw string through so that test
 * doubles could use placeholder names — which bought nothing and cost the
 * type.
 */
export async function assertMintAuthority(
  connection: Connection,
  mint: string,
  signer: string,
  keypairPath: string,
): Promise<void> {
  const { value } = await connection.getParsedAccountInfo(new PublicKey(mint));

  if (!value) {
    throw new Error(`Mint account ${mint} does not exist on this cluster.`);
  }

  const data = value.data as ParsedAccountData | Buffer;
  const parsed = Buffer.isBuffer(data) ? undefined : data.parsed;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(
      `Mint account ${mint} could not be parsed — its data is not a parsed spl-token account.`,
    );
  }

  if (parsed.type !== 'mint') {
    throw new Error(`Account ${mint} is not a mint (found type "${parsed.type}").`);
  }

  const mintAuthority = parsed.info?.mintAuthority ?? null;

  if (mintAuthority === null) {
    throw new Error(
      `Mint ${mint} has no mint authority — it was revoked, so no key, including ` +
        `${signer} (${keypairPath}), can mint more of it.`,
    );
  }

  if (mintAuthority !== signer) {
    throw new Error(
      `REFUSING: the configured signer is not this mint's authority.\n\n` +
        `  mint            ${mint}\n` +
        `  mint authority  ${mintAuthority}\n` +
        `  configured key  ${signer}\n` +
        `  from            ${keypairPath}\n\n` +
        `Point the \`solana\` CLI's keypair at ${mintAuthority}, or use a mint whose ` +
        `authority is ${signer}.`,
    );
  }
}
