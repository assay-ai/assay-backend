import { hashDomain, keccak256, toBytes } from 'viem';

import { EVM_DOMAIN_NAME, EVM_DOMAIN_VERSION, evmDomain } from '@modules/chains/evm/eip712/domain';
import {
  hashRequestWithdraw,
  hashSetLimits,
  REQUEST_WITHDRAW_TYPES,
  SET_LIMITS_TYPES,
} from '@modules/chains/evm/eip712/escrow-control';
import { EvmVoucher, hashVoucher, VOUCHER_TYPES } from '@modules/chains/evm/eip712/voucher';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';

const ESCROW = '0x1111111111111111111111111111111111111111' as const;
const OTHER_ESCROW = '0x2222222222222222222222222222222222222222' as const;

const TESTNET = evmDomain(CHAIN_IDS.ROBINHOOD_TESTNET, ESCROW);
const MAINNET = evmDomain(CHAIN_IDS.ROBINHOOD_MAINNET, ESCROW);
const OTHER = evmDomain(CHAIN_IDS.ROBINHOOD_TESTNET, OTHER_ESCROW);

const VOUCHER: EvmVoucher = {
  payer: '0x3333333333333333333333333333333333333333',
  provider: '0x4444444444444444444444444444444444444444',
  amount: 1_000_000n,
  resourceHash: keccak256(toBytes('https://api.platform.io/tools/search_web')),
  requestHash: keccak256(toBytes('{"q":"solana"}')),
  seq: 42n,
  issuedAt: 1_785_999_800n,
  expiresAt: 1_785_999_900n,
};

/**
 * The EIP-712 encoders, pinned to a vector computed by a different
 * implementation.
 *
 * Every `0x…` literal below came out of **foundry `cast`** on the pinned build
 * (1.2.1-nightly, commit `7e68208e`) on 2026-09-09, walking the EIP-712
 * construction by hand:
 *
 * ```
 * cast keccak "<typehash preimage>"
 * cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' \
 *   $EIP712_DOMAIN_TYPEHASH $(cast keccak "Assay Settlement") $(cast keccak "2") \
 *   46630 0x1111111111111111111111111111111111111111)"           # domain separator
 * cast keccak "$(cast abi-encode 'f(bytes32,address,address,uint64,…)' $VOUCHER_TYPEHASH …)"
 * cast keccak $(cast concat-hex 0x1901 $DOMAIN_SEPARATOR $STRUCT_HASH)   # the digest
 * ```
 *
 * That matters more than it looks. A spec that computes
 * `keccak256(abi.encode(TYPEHASH, …))` and compares it to the encoder computing
 * the same expression asserts that `===` works — it is green against an encoder
 * that signs the wrong fields, as long as it signs them consistently. These
 * literals were produced by code that shares nothing with viem, so agreeing
 * with them is evidence.
 *
 * The preimage strings are pinned separately, against `assay-evm/src/Types.sol`:
 * two structurally different fields of the same width (`issuedAt`/`expiresAt`,
 * both `uint64`) can be swapped without changing any struct-hash **shape**, and
 * the rendered preimage is what catches that.
 */
describe('the EIP-712 encoders agree with assay-evm/src/Types.sol', () => {
  describe('the typehash preimages', () => {
    // `Types.sol` lines 128-144. Rendering the encoder's own field list back
    // into the Solidity string is what makes the ORDER of that list
    // load-bearing rather than incidental.
    it.each([
      [
        'Voucher',
        'Voucher(address payer,address provider,uint64 amount,bytes32 resourceHash,bytes32 requestHash,uint64 seq,uint64 issuedAt,uint64 expiresAt)',
        '0x397e399cf6e4a1b85e582b06b939251807210d31d2743a9bdfece4c1d8ad9435',
        VOUCHER_TYPES.Voucher,
      ],
      [
        'SetLimits',
        'SetLimits(address buyer,uint64 maxVoucherAmount,uint64 maxPerWindow,uint64 nonce,uint64 deadline)',
        '0x6409f2b846e600c202b701219606d813366c1189be8b2aec38c50a5e8136dafc',
        SET_LIMITS_TYPES.SetLimits,
      ],
      [
        'RequestWithdraw',
        'RequestWithdraw(address buyer,uint64 amount,uint64 nonce,uint64 deadline)',
        '0xc8cc528b1ce6b0f90c78a68b0a6e8bf221eaae4e39d597faa197eb0b950f5504',
        REQUEST_WITHDRAW_TYPES.RequestWithdraw,
      ],
    ] as const)(
      '%s renders to its Solidity preimage and typehash',
      (name, preimage, typehash, fields) => {
        const rendered = `${name}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
        expect(rendered).toBe(preimage);
        // …and the typehash `cast keccak` produced for that same string, so the
        // pin covers the bytes the contract actually compares against and not
        // only a string somebody could edit on both sides.
        expect(keccak256(toBytes(rendered))).toBe(typehash);
      },
    );
  });

  describe('the domain', () => {
    it('is name "Assay Settlement", version "2", and carries no salt', () => {
      // `verifyingContract` is the PROXY address, which does not move
      // across an upgrade. No `salt` — three fields do all the work.
      expect(TESTNET).toEqual({
        name: 'Assay Settlement',
        version: '2',
        chainId: 46_630,
        verifyingContract: ESCROW,
      });
      expect(EVM_DOMAIN_NAME).toBe('Assay Settlement');
      expect(EVM_DOMAIN_VERSION).toBe('2');
    });

    it.each([
      [
        'testnet, escrow A',
        TESTNET,
        '0x01a0e125a9160ae7be29f3c876038a6402946b19d2615eb6a7b3c4bdd7a98be3',
      ],
      [
        'mainnet, escrow A',
        MAINNET,
        '0xcf6da17124c677713bdd547855d827748726cae426a701f72a0908aae840a97c',
      ],
      [
        'testnet, escrow B',
        OTHER,
        '0x7edd459b084835e2e155f798ef783855f2ddfe93aef0df1e4949fb28febded70',
      ],
    ] as const)('separator for %s is the one cast computed', (_label, domain, separator) => {
      expect(
        hashDomain({
          domain,
          types: {
            EIP712Domain: [
              { name: 'name', type: 'string' },
              { name: 'version', type: 'string' },
              { name: 'chainId', type: 'uint256' },
              { name: 'verifyingContract', type: 'address' },
            ],
          },
        }),
      ).toBe(separator);
    });

    it('refuses a non-eip155 chain id rather than encoding a nonsense chainId', () => {
      // `parseChainId('solana:5eykt…').reference` is a base58 genesis hash;
      // `Number()` of it is NaN, and NaN would encode as 0 — a domain every
      // EVM chain shares. The refusal is what stops that.
      expect(() => evmDomain(CHAIN_IDS.SOLANA_DEVNET, ESCROW)).toThrow(/solana/);
      // positive control: the eip155 chain it is supposed to accept
      expect(() => evmDomain(CHAIN_IDS.ROBINHOOD_TESTNET, ESCROW)).not.toThrow();
    });
  });

  describe('the digests', () => {
    it('the voucher hashes to the vector cast produced', () => {
      expect(hashVoucher(VOUCHER, TESTNET)).toBe(
        '0xb50bc1d1af99579d1bdef9a5531e5a4114abe8c0d6352c4956bb66bc439241e1',
      );
    });

    it('the same voucher hashes differently — and to a pinned value — on another chain', () => {
      // The same buyer key controls the same address on every EVM chain,
      // so without `chainId` a voucher signed for the testnet escrow is valid
      // against the mainnet escrow of the same buyer. Pinned rather than merely
      // asserted unequal: `not.toBe` is satisfied by an encoder that mixes the
      // chain in wrongly as well as by one that mixes it in correctly.
      expect(hashVoucher(VOUCHER, MAINNET)).toBe(
        '0x6315685c7adfcba0f0838ad7e8fa5eaba5db6d0356e45f694a818f4f95464c29',
      );
      expect(hashVoucher(VOUCHER, MAINNET)).not.toBe(hashVoucher(VOUCHER, TESTNET));
    });

    it('the same voucher hashes differently against a different escrow', () => {
      expect(hashVoucher(VOUCHER, OTHER)).toBe(
        '0xbf60f19e26977dd3a5f227953edcbc06bfdd555499e4c3edf115dea30f6bdf43',
      );
      expect(hashVoucher(VOUCHER, OTHER)).not.toBe(hashVoucher(VOUCHER, TESTNET));
    });

    it('setLimits and requestWithdraw hash to their own vectors', () => {
      expect(
        hashSetLimits(
          {
            buyer: VOUCHER.payer,
            maxVoucherAmount: VOUCHER.amount,
            maxPerWindow: VOUCHER.amount,
            nonce: VOUCHER.seq,
            deadline: VOUCHER.expiresAt,
          },
          TESTNET,
        ),
      ).toBe('0x28240eeb96ba4005f625562a6636451118c4dde182896367595226de8efb421a');

      expect(
        hashRequestWithdraw(
          {
            buyer: VOUCHER.payer,
            amount: VOUCHER.amount,
            nonce: VOUCHER.seq,
            deadline: VOUCHER.expiresAt,
          },
          TESTNET,
        ),
      ).toBe('0x5a889ff93f9f2a9ff89dd9c4da47cdcd15944fa9bb69563dd16a5eeffbca7b89');
    });

    it('a voucher and a set-limits message with the same numbers hash differently', () => {
      // The cross-kind replay guard: a distinct typehash INSIDE the hashed
      // preimage, which is stronger than a length check that happens to reject
      // first. Both sides are pinned above, so this restates the property the
      // vectors already prove — and states it where a reader looks for it.
      expect(hashVoucher(VOUCHER, TESTNET)).not.toBe(
        hashSetLimits(
          {
            buyer: VOUCHER.payer,
            maxVoucherAmount: VOUCHER.amount,
            maxPerWindow: VOUCHER.amount,
            nonce: VOUCHER.seq,
            deadline: VOUCHER.expiresAt,
          },
          TESTNET,
        ),
      );
    });
  });

  /**
   * Every field is signed.
   *
   * An earlier version of this test was **inert**: `Voucher[8] memory mutated;
   * mutated[i] = base;` copied a pointer, so every "mutant" was the base and an
   * encoder that never signed `payer` passed. The TypeScript shape of the same
   * bug is one object reused across cases, or an array of references.
   *
   * So each case builds its own object from the base with spread, and the first
   * assertion is that the mutant really differs **in exactly one field**. A
   * fixture wrong in two ways passes for the wrong reason and would still pass
   * with the guard deleted; a fixture wrong in none passes for no reason at all.
   */
  describe('mutating any one signed field changes the digest', () => {
    const FIELDS = Object.keys(VOUCHER) as ReadonlyArray<keyof EvmVoucher>;

    it('covers all eight fields the Solidity declares', () => {
      expect(FIELDS).toEqual([
        'payer',
        'provider',
        'amount',
        'resourceHash',
        'requestHash',
        'seq',
        'issuedAt',
        'expiresAt',
      ]);
    });

    it.each(FIELDS)('%s', (field) => {
      const current = VOUCHER[field];
      const mutated: EvmVoucher = {
        ...VOUCHER,
        [field]:
          typeof current === 'bigint'
            ? current + 1n
            : (`0x${'5'.repeat(current.length - 2)}` as `0x${string}`),
      };

      const differing = FIELDS.filter((name) => mutated[name] !== VOUCHER[name]);
      expect(differing).toEqual([field]);

      expect(hashVoucher(mutated, TESTNET)).not.toBe(hashVoucher(VOUCHER, TESTNET));
    });
  });
});
