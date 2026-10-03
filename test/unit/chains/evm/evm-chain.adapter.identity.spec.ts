import { ChainErrorCode } from '@modules/chains/errors/chains.errors';
import { ASSET_IDS } from '@modules/chains/ports/asset-registry';
import { CHAIN_IDS, ChainId } from '@modules/chains/ports/caip.types';
import { EvmChainAdapter } from '@modules/chains/evm/evm-chain.adapter';

import { deployment } from './evm-fixtures';

/**
 * The half of `EvmChainAdapter` the shared conformance suite cannot demand.
 *
 * `chain-adapter.contract.ts` is chain-agnostic by construction, so nothing in
 * it may name `0x`, EIP-55 or a `Deposited` event. Everything that is true of
 * *this* chain and no other lives here, and the two files are complementary in
 * the same way `solana-chain.adapter.spec.ts` and `solana-adapter.contract.spec.ts`
 * are.
 */

const TESTNET = CHAIN_IDS.ROBINHOOD_TESTNET;
/** Base — same namespace, and this deployment does not serve it. */
const UNSERVED_EIP155 = CHAIN_IDS.BASE_MAINNET;
const USDG = ASSET_IDS.USDG_ROBINHOOD_TESTNET;

/** EIP-55 checksummed. `0x915Ef7…` is testnet USDG; this is an arbitrary EOA. */
const CHECKSUMMED = '0x5B38Da6a701c568545dCfcB03FcB875f56beddC4';
const LOWERCASE = CHECKSUMMED.toLowerCase();
/** One character of the checksum case flipped: `B` → `b` at index 3. */
const BAD_CHECKSUM = '0x5b38Da6a701c568545dCfcB03FcB875f56beddC4';

const build = () =>
  new EvmChainAdapter(new Map(), new Map([[TESTNET, deployment(TESTNET)]]), [TESTNET]);

describe('EvmChainAdapter address identity', () => {
  it('accepts a correctly checksummed address', () => {
    expect(build().isValidAddress(TESTNET, CHECKSUMMED)).toBe(true);
  });

  it('accepts an all-lowercase address', () => {
    // All-lowercase carries no checksum claim, so there is nothing to disagree
    // with. Rejecting it would break every address copied out of an explorer.
    expect(build().isValidAddress(TESTNET, LOWERCASE)).toBe(true);
  });

  it('REFUSES a mixed-case address whose checksum does not verify', () => {
    // This is the whole point of the method on EVM, and it is exactly what the
    // shared conformance suite cannot demand: a typo in an address becomes a
    // transfer to an address nobody holds the key for.
    expect(build().isValidAddress(TESTNET, BAD_CHECKSUM)).toBe(false);
  });

  it.each([
    ['', 'empty'],
    ['0x', 'prefix only'],
    [`0x${'a'.repeat(41)}`, '41 nibbles'],
    [`${CHECKSUMMED}\n`, 'trailing newline'],
  ])('refuses "%s" (%s)', (value) => {
    expect(build().isValidAddress(TESTNET, value)).toBe(false);
  });

  it('refuses a Solana address', () => {
    expect(build().isValidAddress(TESTNET, '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')).toBe(
      false,
    );
  });

  it('normalises to the checksummed form so one identity has one string', () => {
    // A DB key that is sometimes lowercase and sometimes checksummed is two
    // rows for one buyer, which is how a balance becomes unreachable.
    expect(build().toAccountId(TESTNET, LOWERCASE)).toBe(`${TESTNET}:${CHECKSUMMED}`);
  });

  it('round-trips a checksummed address', () => {
    const account = build().toAccountId(TESTNET, CHECKSUMMED);
    expect(build().parseAccountId(account)).toEqual({
      chainId: TESTNET,
      address: CHECKSUMMED,
    });
  });

  it('refuses a chain in its own namespace that it does not serve', () => {
    // Contract assertion 22 says "outside supportedChains", not "outside the
    // namespace". A guard written as namespace equality serves Base happily —
    // which is the devnet-deployment-reconciling-mainnet incident, one chain
    // over.
    let code: string | undefined;
    try {
      build().toAccountId(UNSERVED_EIP155, CHECKSUMMED);
    } catch (error) {
      code = (error as { errorCode: string }).errorCode;
    }
    expect(code).toBe(ChainErrorCode.CHAIN_NAMESPACE_MISMATCH);
  });

  it('throws CHAIN_INVALID_ADDRESS rather than returning a malformed AccountId', () => {
    let code: string | undefined;
    try {
      build().toAccountId(TESTNET, BAD_CHECKSUM);
    } catch (error) {
      code = (error as { errorCode: string }).errorCode;
    }
    expect(code).toBe(ChainErrorCode.CHAIN_INVALID_ADDRESS);
  });

  it('refuses a Solana chain id as a namespace mismatch, not as an unknown network', () => {
    let code: string | undefined;
    try {
      build().toAccountId(CHAIN_IDS.SOLANA_MAINNET, CHECKSUMMED);
    } catch (error) {
      code = (error as { errorCode: string }).errorCode;
    }
    expect(code).toBe(ChainErrorCode.CHAIN_NAMESPACE_MISMATCH);
  });

  it('the vault is the owner itself — there is no per-asset account to derive', async () => {
    // ATAs vanish: getVaultAccount(owner, asset) on EVM is the identity
    // function; there is one token contract and one balance mapping. The
    // pooled escrow contract is NOT the answer here: it is measured that a
    // plain transfer to it credits nobody, so a surface that renders it as a
    // send-to address loses the buyer's money. Where the contract IS needed it
    // travels in `extra.contract`, never as `payTo`.
    const adapter = build();
    const owner = adapter.toAccountId(TESTNET, CHECKSUMMED);

    await expect(adapter.getVaultAccount(owner, USDG)).resolves.toBe(owner);
  });

  it('normalises a lower-case owner into one vault string', async () => {
    const adapter = build();
    await expect(adapter.getVaultAccount(`${TESTNET}:${LOWERCASE}` as never, USDG)).resolves.toBe(
      `${TESTNET}:${CHECKSUMMED}`,
    );
  });

  it('refuses an asset that does not live on the owner’s chain', async () => {
    const adapter = build();
    const owner = adapter.toAccountId(TESTNET, CHECKSUMMED);
    await expect(
      adapter.getVaultAccount(owner, ASSET_IDS.USDC_SOLANA_MAINNET),
    ).rejects.toMatchObject({ errorCode: ChainErrorCode.CHAIN_ASSET_NOT_ON_CHAIN });
  });

  it('reports the served chains it was given, and only those', () => {
    expect(build().supportedChains).toEqual([TESTNET]);
    expect(build().supportedChains).not.toContain(UNSERVED_EIP155 as ChainId);
  });
});
