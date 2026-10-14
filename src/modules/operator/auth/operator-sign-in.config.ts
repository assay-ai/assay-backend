/**
 * What the console's sign-in message must say, read once from the environment.
 *
 * `domain` and `uri` are what make a signature collected here useless to any
 * other site and vice versa (EIP-4361): the wallet shows the domain to the
 * person signing, and the backend refuses a message naming any other. Both are
 * required — an unset domain refuses every sign-in rather than accepting any.
 */
export interface OperatorSignInConfig {
  /** RFC 3986 authority of the console, e.g. `console.goassay.ai` or `localhost:3000`. */
  readonly domain: string;
  /** The console's sign-in page, e.g. `https://console.goassay.ai/operator`. */
  readonly uri: string;
  /** EIP-155 chain id named in the message. Not a chain the signature touches. */
  readonly chainId: number;
  /** How long a session lasts once issued. */
  readonly sessionTtlSeconds: number;
}

export const OPERATOR_SIGN_IN_CONFIG = 'OPERATOR_SIGN_IN_CONFIG';

/** The statement every sign-in message carries, word for word. */
export const OPERATOR_SIGN_IN_STATEMENT = 'Sign in to the Assay operator console';

/** A challenge is good for five minutes; the message's expirationTime says so. */
export const OPERATOR_CHALLENGE_TTL_SECONDS = 300;

export const DEFAULT_OPERATOR_SIGN_IN_CHAIN_ID = 46630;
export const DEFAULT_OPERATOR_SESSION_TTL_HOURS = 8;

export function loadOperatorSignInConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperatorSignInConfig {
  const chainId = Number.parseInt(env.OPERATOR_SIGN_IN_CHAIN_ID ?? '', 10);
  const hours = Number.parseInt(env.OPERATOR_SESSION_TTL_HOURS ?? '', 10);
  return Object.freeze({
    domain: (env.OPERATOR_SIGN_IN_DOMAIN ?? '').trim(),
    uri: (env.OPERATOR_SIGN_IN_URI ?? '').trim(),
    chainId: chainId > 0 ? chainId : DEFAULT_OPERATOR_SIGN_IN_CHAIN_ID,
    sessionTtlSeconds:
      (hours > 0 && hours <= 24 ? hours : DEFAULT_OPERATOR_SESSION_TTL_HOURS) * 3600,
  });
}
