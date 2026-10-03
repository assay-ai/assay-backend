/**
 * The devnet USDC-standin mint's decimal places, in one place.
 *
 * `mint-setup.ts` creates the mint with this many decimals and `faucet-args.ts`
 * converts a user-typed amount into atomic units with it. Those two disagreeing
 * would not fail anywhere — it would quietly hand out a thousand times too much
 * or too little — so they read the same constant rather than each declaring 6.
 *
 * It lives in its own module, with no imports, so the pure argument parser does
 * not have to pull in `@solana/kit` and a `Connection` to learn one number.
 */
export const DEVNET_TOKEN_DECIMALS = 6;
