import { hashTypedData, keccak256, recoverTypedDataAddress, toBytes } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmDomain } from '@modules/chains/evm/eip712/domain';
import {
  AUTHORIZE_DELEGATE_TYPES,
  authorizeDelegateTypedData,
  AuthorizeDelegateMessage,
  hashAuthorizeDelegate,
  hashRevokeDelegate,
  REVOKE_DELEGATE_TYPES,
  revokeDelegateTypedData,
  RevokeDelegateMessage,
} from '@modules/chains/evm/eip712/delegation';
import { SET_LIMITS_TYPES } from '@modules/chains/evm/eip712/escrow-control';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

const ESCROW = '0x1111111111111111111111111111111111111111' as const;
const TESTNET = evmDomain(CHAIN_IDS.ROBINHOOD_TESTNET, ESCROW);

const AUTHORIZE: AuthorizeDelegateMessage = {
  payer: '0x3333333333333333333333333333333333333333',
  delegate: '0x5555555555555555555555555555555555555555',
  maxVoucherAmount: 1_000_000n,
  maxPerWindow: 10_000_000n,
  validUntil: 1_788_000_000n,
  nonce: 7n,
  deadline: 1_786_000_100n,
};

const REVOKE: RevokeDelegateMessage = {
  payer: '0x3333333333333333333333333333333333333333',
  delegate: '0x5555555555555555555555555555555555555555',
  nonce: 8n,
  deadline: 1_786_000_100n,
};

/**
 * The delegation messages, pinned the way `eip712.spec.ts` pins the others:
 * the preimage strings against `assay-evm/src/Types.sol`, the typehashes and
 * both digests against vectors **foundry `cast`** produced by hand (domain
 * separator for eip155:46630 / 0x1111…: 0x7a73d7d6…c3db), so agreeing with
 * them is evidence and not `===` against itself.
 */
describe('the delegation EIP-712 encoders agree with assay-evm/src/Types.sol', () => {
  it.each([
    [
      'AuthorizeDelegate',
      'AuthorizeDelegate(address payer,address delegate,uint64 maxVoucherAmount,uint64 maxPerWindow,uint64 validUntil,uint64 nonce,uint64 deadline)',
      '0x786954adebf8c05339e9845386e14cc57d1612df2dafbd44bfbb75458b56f3ed',
      AUTHORIZE_DELEGATE_TYPES.AuthorizeDelegate,
    ],
    [
      'RevokeDelegate',
      'RevokeDelegate(address payer,address delegate,uint64 nonce,uint64 deadline)',
      '0xb76fe89d3e35d0a6374de5a472a654e25b45926d78c088c444d137fcba8790bc',
      REVOKE_DELEGATE_TYPES.RevokeDelegate,
    ],
  ] as const)(
    '%s renders to its Solidity preimage and typehash',
    (name, preimage, typehash, fields) => {
      const rendered = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
      expect(rendered).toBe(preimage);
      expect(keccak256(toBytes(rendered))).toBe(typehash);
    },
  );

  it('the authorisation hashes to the vector cast produced', () => {
    expect(hashAuthorizeDelegate(AUTHORIZE, TESTNET)).toBe(
      '0x327bb143b5d7ac8b7987ad5e22f93caa754cd9f3a1f6c79224ab7d70dc48e908',
    );
  });

  it('the revocation hashes to the vector cast produced', () => {
    expect(hashRevokeDelegate(REVOKE, TESTNET)).toBe(
      '0x5fdbc4c99d08871d0cb076aa5903ae5483547455f24b0083bfc71af88d2adcfd',
    );
  });

  it.each(Object.keys(AUTHORIZE) as (keyof AuthorizeDelegateMessage)[])(
    'changing the signed field %s changes the authorisation digest',
    (field) => {
      const changed = { ...AUTHORIZE } as Record<string, unknown>;
      const value = AUTHORIZE[field];
      changed[field] =
        typeof value === 'bigint' ? value + 1n : '0x6666666666666666666666666666666666666666';
      expect(
        hashAuthorizeDelegate(changed as unknown as AuthorizeDelegateMessage, TESTNET),
      ).not.toBe(hashAuthorizeDelegate(AUTHORIZE, TESTNET));
    },
  );

  it('is its own primary type, distinct from SetLimits, so one door cannot take the other door’s signature', () => {
    expect(authorizeDelegateTypedData(AUTHORIZE, TESTNET).primaryType).toBe('AuthorizeDelegate');
    expect(revokeDelegateTypedData(REVOKE, TESTNET).primaryType).toBe('RevokeDelegate');
    expect(Object.keys(AUTHORIZE_DELEGATE_TYPES)).not.toContain(Object.keys(SET_LIMITS_TYPES)[0]);
  });

  it('a wallet signature over the typed data recovers to the payer', async () => {
    const payer = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const message = { ...AUTHORIZE, payer: payer.address };
    const typed = authorizeDelegateTypedData(message, TESTNET);
    const signature = await payer.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature })).toBe(payer.address);
    expect(hashTypedData(typed)).toBe(hashAuthorizeDelegate(message, TESTNET));
  });
});
