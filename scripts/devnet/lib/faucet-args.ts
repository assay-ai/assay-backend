/**
 * Argument parsing for `yarn devnet:faucet <address> <amount>`.
 *
 * Pure and side-effect free: no `Connection`, no file system, no process
 * exit. All arithmetic runs on `bigint` — the amount is user-typed decimal
 * text, and routing it through `Number` even once is how a faucet mints the
 * wrong quantity.
 */
import { DEVNET_TOKEN_DECIMALS as DECIMALS } from './token-decimals';

const DEFAULT_TOKENS = 100;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_PATTERN = new RegExp(`^[${BASE58_ALPHABET}]{32,44}$`);

export interface FaucetArgs {
  readonly recipient: string;
  readonly targetAtomic: bigint;
}

/**
 * Parses `[recipient, amount?]` CLI argv (already stripped of `node`/script
 * path) into a validated recipient address and a target balance in atomic
 * units (`DEVNET_TOKEN_DECIMALS`).
 */
export function parseFaucetArgs(argv: readonly string[]): FaucetArgs {
  const [recipient, amount] = argv;

  if (!recipient) {
    throw new Error('Missing recipient: usage is `yarn devnet:faucet <address> [amount]`.');
  }
  if (!BASE58_PATTERN.test(recipient)) {
    throw new Error(
      `Recipient "${recipient}" is not a valid base58 Solana address (32-44 base58 characters).`,
    );
  }

  const targetAtomic = parseTokenAmountToAtomic(amount ?? String(DEFAULT_TOKENS));

  return { recipient, targetAtomic };
}

function parseTokenAmountToAtomic(amount: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) {
    throw new Error(`Amount "${amount}" is not a valid decimal number.`);
  }

  const [, whole, fraction = ''] = match;
  if (fraction.length > DECIMALS) {
    throw new Error(
      `Amount "${amount}" is finer than one atomic unit — at most ${DECIMALS} decimal places are representable.`,
    );
  }

  const paddedFraction = fraction.padEnd(DECIMALS, '0');
  return BigInt(whole) * 10n ** BigInt(DECIMALS) + BigInt(paddedFraction || '0');
}
