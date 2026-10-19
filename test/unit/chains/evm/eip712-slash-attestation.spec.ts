import { keccak256, recoverAddress, toBytes, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { evmDomain } from '@modules/chains/evm/eip712/domain';
import {
  EVM_RESPONSE_CLASS_DATA_FAIL,
  EvmSlashAttestation,
  hashSlashAttestation,
  SLASH_ATTESTATION_TYPES,
} from '@modules/chains/evm/eip712/slash-attestation';
import { CHAIN_IDS } from '@modules/chains/ports/caip.types';
import { Secp256k1EnvSigner } from '@modules/verification/signing/backends/secp256k1-env.signer';

/**
 * Every literal below came out of foundry `cast` (nightly, 2026-10-11), sharing
 * nothing with viem:
 *
 * ```
 * cast keccak "SlashAttestation(bytes32 requestId,…,uint64 expiresAt)"            # typehash
 * cast keccak "$(cast abi-encode 'f(bytes32,bytes32,bytes32,uint256,address)' \
 *   $EIP712_DOMAIN_TYPEHASH $(cast keccak 'Assay Settlement') $(cast keccak '2') 46630 $STAKE)"
 * cast keccak "$(cast abi-encode 'f(bytes32,bytes32,address,address,uint8,uint64,bytes32,uint64,uint64)' …)"
 * cast keccak $(cast concat-hex 0x1901 $DOMAIN_SEPARATOR $STRUCT_HASH)
 * ```
 *
 * The domain separator also equals `AssayStake.DOMAIN_SEPARATOR()` read live
 * from eip155:46630 on the same day.
 */
const STAKE = '0x0aF4D08f97B4FA8Ba3E47Cb025aE8CaD509bc73c' as const;
const DOMAIN = evmDomain(CHAIN_IDS.ROBINHOOD_TESTNET, STAKE);

const ATTESTATION: EvmSlashAttestation = {
  requestId: `0x${'ab'.repeat(32)}`,
  provider: '0xA271A3407D3302f4b4Fbe469b9188487cedd7d45',
  beneficiary: '0x64FEcBe18e8998cB2990bCE631A042f8E2be1659',
  status: EVM_RESPONSE_CLASS_DATA_FAIL,
  penalty: 150_001n,
  policy: `0x${'cd'.repeat(32)}`,
  issuedAt: 1_791_700_000n,
  expiresAt: 1_791_700_600n,
};

describe('SlashAttestation agrees with assay-evm/src/Types.sol', () => {
  it('renders the typehash preimage Types.sol declares', () => {
    const preimage = `SlashAttestation(${SLASH_ATTESTATION_TYPES.SlashAttestation.map(
      (field) => `${field.type} ${field.name}`,
    ).join(',')})`;
    expect(preimage).toBe(
      'SlashAttestation(bytes32 requestId,address provider,address beneficiary,uint8 status,uint64 penalty,bytes32 policy,uint64 issuedAt,uint64 expiresAt)',
    );
    expect(keccak256(toBytes(preimage))).toBe(
      '0x720add31d977b34e2bd07233549b49e34cea20ffa4e845af7b6bd5cc4f52ddca',
    );
  });

  it('produces the digest cast produced', () => {
    expect(hashSlashAttestation(ATTESTATION, DOMAIN)).toBe(
      '0xfbcd4977888a6d79b323d1246293228a5c232d072e69079a894dc5446487ed38',
    );
  });

  it('is signed by the platform secp256k1 backend in a shape Sig.recover accepts', async () => {
    const secretKey = new Uint8Array(32).fill(7);
    const expected = privateKeyToAccount(toHex(secretKey)).address;
    const signer = new Secp256k1EnvSigner(
      [
        {
          keyId: 'v1',
          chainId: CHAIN_IDS.ROBINHOOD_TESTNET,
          secretKey: Uint8Array.from(secretKey),
        },
      ],
      'test',
    );
    const digest = hashSlashAttestation(ATTESTATION, DOMAIN);
    const signature = await signer.sign('v1', toBytes(digest));

    expect(signature).toHaveLength(65);
    expect([27, 28]).toContain(signature[64]);
    await expect(recoverAddress({ hash: digest, signature: toHex(signature) })).resolves.toBe(
      expected,
    );
  });
});
