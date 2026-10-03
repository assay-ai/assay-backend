import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  EVM_RELAYER_KEYS_ENV,
  takeEvmRelayerKeys,
} from '@modules/chains/evm/evm-relayer-key-source';
import { resetEnvSigningKeyCacheForTests } from '@modules/verification/signing/backends/env-key-source';

/**
 * `EVM_RELAYER_KEYS`, and the properties it inherits by going through the same
 * `takeOnceFromEnv` the verifier keys go through.
 *
 * The deletion is the reason that sharing is not an economy: a second
 * key-bearing variable read by a second, weaker parser is how one of them ends
 * up surviving boot and reaching a crash report.
 */
const SCALAR = '4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318';

describe('takeEvmRelayerKeys', () => {
  beforeEach(() => resetEnvSigningKeyCacheForTests());

  it('removes the variable from the environment, key and all', () => {
    const env = { [EVM_RELAYER_KEYS_ENV]: keysJson() } as NodeJS.ProcessEnv;

    const keys = takeEvmRelayerKeys(env);

    expect(keys).toHaveLength(1);
    expect(env[EVM_RELAYER_KEYS_ENV]).toBeUndefined();
    // Not merely undefined — GONE. `Object.keys(process.env)` is what a crash
    // reporter walks, and a key present with an undefined value still appears.
    expect(Object.keys(env)).not.toContain(EVM_RELAYER_KEYS_ENV);
  });

  it('deletes it even when the value is malformed', () => {
    // The run where somebody attaches a debugger is precisely the run where
    // parsing failed.
    const env = { [EVM_RELAYER_KEYS_ENV]: `[{"chainId":` } as NodeJS.ProcessEnv;

    expect(() => takeEvmRelayerKeys(env)).toThrow(/not valid JSON/);
    expect(Object.keys(env)).not.toContain(EVM_RELAYER_KEYS_ENV);
  });

  it('never quotes the value it failed to parse', () => {
    // `JSON.parse`'s own message contains the offending input, so re-raising it
    // would print the key into the boot log.
    const env = { [EVM_RELAYER_KEYS_ENV]: `[{"chainId":"x","secretKey":"${SCALAR}"` };

    const error = catchError(() => takeEvmRelayerKeys(env as NodeJS.ProcessEnv));

    expect(error?.message).not.toContain(SCALAR);
    expect(error?.message).not.toContain(SCALAR.slice(0, 8));
  });

  it('reads an unset or empty variable as no keys, not as an error', () => {
    // A process that relays nothing — the API, the MCP server — must boot.
    expect(takeEvmRelayerKeys({} as NodeJS.ProcessEnv)).toEqual([]);
    resetEnvSigningKeyCacheForTests();
    expect(takeEvmRelayerKeys({ [EVM_RELAYER_KEYS_ENV]: '  ' } as NodeJS.ProcessEnv)).toEqual([]);
  });

  it('refuses a solana chain', () => {
    // The fee payer on Solana is `FeePayerSignerPort` and a different key. A
    // solana entry here yields a relayer nobody can use and — worse — a
    // deployment that believes it has one.
    const env = {
      [EVM_RELAYER_KEYS_ENV]: JSON.stringify([
        { chainId: CHAIN_IDS.SOLANA_DEVNET, secretKey: SCALAR },
      ]),
    };

    expect(() => takeEvmRelayerKeys(env as NodeJS.ProcessEnv)).toThrow(/solana/);
  });

  it('refuses two entries for one chain', () => {
    // Which of them sends would otherwise depend on map insertion order, and
    // the two would draw nonces against different accounts.
    const env = {
      [EVM_RELAYER_KEYS_ENV]: JSON.stringify([
        { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: SCALAR },
        { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: SCALAR },
      ]),
    };

    expect(() => takeEvmRelayerKeys(env as NodeJS.ProcessEnv)).toThrow(/appears twice/);
  });

  it('refuses a scalar of the wrong length, and takes one with or without 0x', () => {
    const short = {
      [EVM_RELAYER_KEYS_ENV]: JSON.stringify([
        { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: SCALAR.slice(0, 60) },
      ]),
    };
    expect(() => takeEvmRelayerKeys(short as NodeJS.ProcessEnv)).toThrow(/32-byte hex scalar/);

    resetEnvSigningKeyCacheForTests();
    const prefixed = {
      [EVM_RELAYER_KEYS_ENV]: JSON.stringify([
        { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: `0x${SCALAR.toUpperCase()}` },
      ]),
    };
    expect(takeEvmRelayerKeys(prefixed as NodeJS.ProcessEnv)[0].secretKey).toBe(`0x${SCALAR}`);
  });
});

function keysJson(): string {
  return JSON.stringify([{ chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: SCALAR }]);
}

function catchError(fn: () => unknown): Error | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error as Error;
  }
}
