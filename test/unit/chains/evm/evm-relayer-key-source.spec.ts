import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import {
  EVM_REDEEMER_KEYS_ENV,
  EVM_RELAYER_KEYS_ENV,
  EvmRelayerKeySource,
  assertDistinctRedeemerKeys,
  keyAddressesByChain,
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

/** A second, distinct scalar for the redeemer. */
const REDEEMER_SCALAR = '8da4ef21b864d2cc526dbdb2a120bd2874c36c9d0a1fb7f8c63d7f7a8b41de8f';

describe('takeEvmRelayerKeys(env, EVM_REDEEMER_KEYS)', () => {
  beforeEach(() => resetEnvSigningKeyCacheForTests());

  it('parses the redeemer variable with the same shape, and deletes only that variable', () => {
    const env = {
      [EVM_RELAYER_KEYS_ENV]: keysJson(),
      [EVM_REDEEMER_KEYS_ENV]: JSON.stringify([
        { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: REDEEMER_SCALAR },
      ]),
    } as NodeJS.ProcessEnv;

    const redeemer = takeEvmRelayerKeys(env, EVM_REDEEMER_KEYS_ENV);

    expect(redeemer).toEqual([
      { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: `0x${REDEEMER_SCALAR}` },
    ]);
    expect(Object.keys(env)).not.toContain(EVM_REDEEMER_KEYS_ENV);
    // The relayer's variable is a separate take: still there until it is read.
    expect(env[EVM_RELAYER_KEYS_ENV]).toBeDefined();
    expect(takeEvmRelayerKeys(env)[0].secretKey).toBe(`0x${SCALAR}`);
  });

  it('names EVM_REDEEMER_KEYS, never the value, when it is malformed', () => {
    const env = {
      [EVM_REDEEMER_KEYS_ENV]: `[{"chainId":"eip155:46630","secretKey":"${REDEEMER_SCALAR}"`,
    } as NodeJS.ProcessEnv;

    const error = catchError(() => takeEvmRelayerKeys(env, EVM_REDEEMER_KEYS_ENV));

    expect(error?.message).toContain(EVM_REDEEMER_KEYS_ENV);
    expect(error?.message).not.toContain(REDEEMER_SCALAR.slice(0, 8));
    expect(Object.keys(env)).not.toContain(EVM_REDEEMER_KEYS_ENV);
  });
});

describe('assertDistinctRedeemerKeys', () => {
  const testnet = (secretKey: string): EvmRelayerKeySource => ({
    chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
    secretKey: `0x${secretKey}`,
  });

  it('refuses a chain whose redeemer key is the relayer key, without printing either', () => {
    const error = catchError(() =>
      assertDistinctRedeemerKeys([testnet(SCALAR)], [testnet(SCALAR)]),
    );

    expect(error).toMatchObject({ errorCode: 'CHAIN_CONFIG_VALUE_INVALID' });
    expect(error?.message).toContain(EVM_REDEEMER_KEYS_ENV);
    expect(error?.message).toContain(CHAIN_IDS.ROBINHOOD_TESTNET);
    expect(error?.message).not.toContain(SCALAR.slice(0, 8));
    // Nor the derived address: the message names the variables and the chain.
    expect(error?.message).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });

  it('compares derived addresses, so a re-spelled scalar is still the same key', () => {
    // `takeEvmRelayerKeys` normalises case, but the check must not depend on it.
    expect(() =>
      assertDistinctRedeemerKeys([testnet(SCALAR)], [testnet(SCALAR.toUpperCase())]),
    ).toThrow(/NOT the EVM_RELAYER_KEYS key/);
  });

  it('accepts distinct keys, and a chain present in only one list', () => {
    expect(() =>
      assertDistinctRedeemerKeys([testnet(SCALAR)], [testnet(REDEEMER_SCALAR)]),
    ).not.toThrow();
    // A missing redeemer (or relayer) is not a boot failure: it fails at the first send.
    expect(() => assertDistinctRedeemerKeys([testnet(SCALAR)], [])).not.toThrow();
    expect(() => assertDistinctRedeemerKeys([], [testnet(SCALAR)])).not.toThrow();
    expect(() =>
      assertDistinctRedeemerKeys(
        [testnet(SCALAR)],
        [{ chainId: CHAIN_IDS.ROBINHOOD_MAINNET, secretKey: `0x${SCALAR}` }],
      ),
    ).not.toThrow();
  });
});

describe('keyAddressesByChain', () => {
  it('maps each chain to the address its key derives to, and carries no key', () => {
    const map = keyAddressesByChain([
      { chainId: CHAIN_IDS.ROBINHOOD_TESTNET, secretKey: `0x${SCALAR}` },
    ]);

    // The well-known address of this test scalar.
    expect(map.get(CHAIN_IDS.ROBINHOOD_TESTNET)).toBe('0x2c7536E3605D9C16a7a3D7b1898e529396a65c23');
    expect(JSON.stringify([...map])).not.toContain(SCALAR.slice(0, 8));
    expect(keyAddressesByChain([]).size).toBe(0);
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
