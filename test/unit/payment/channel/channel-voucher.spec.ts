import { encodeAbiParameters, getAddress, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  bucketId,
  bucketOf,
  CHANNEL_MAX_CUMULATIVE,
  channelKeyOf,
  channelTimeRefusal,
  channelVoucherTypedData,
  packChannelSlot,
  parseChannelVoucher,
  recoverChannelSigner,
  settleSkipReason,
  unpackChannelSlot,
  waivedOf,
} from '@modules/payment/domain/channel/channel-voucher';

const PAYER_KEY = `0x${'11'.repeat(32)}` as const;
const DELEGATE_KEY = `0x${'22'.repeat(32)}` as const;
const payer = privateKeyToAccount(PAYER_KEY);
const delegate = privateKeyToAccount(DELEGATE_KEY);
const PROVIDER = getAddress(`0x${'ab'.repeat(20)}`);
const DOMAIN = {
  name: 'Assay Settlement',
  version: '2',
  chainId: 46630,
  verifyingContract: getAddress(`0x${'cd'.repeat(20)}`),
} as const;
const CHANNEL_ID = `0x${'5a'.repeat(32)}` as `0x${string}`;
const NOW = 1_800_000_000;

function wire(overrides: Record<string, unknown> = {}) {
  return {
    payer: payer.address,
    provider: PROVIDER,
    channelId: CHANNEL_ID,
    cumulative: '300000',
    calls: 3,
    issuedAt: NOW,
    expiresAt: NOW + 240,
    ...overrides,
  };
}

describe('channel voucher (W1 ChannelVoucher, EIP-712 under the escrow domain)', () => {
  it('recovers the payer and a delegate from their own signatures', async () => {
    const message = parseChannelVoucher(wire(), `0x${'00'.repeat(65)}`);
    for (const signer of [payer, delegate]) {
      const signature = await signer.signTypedData(
        channelVoucherTypedData(message, DOMAIN) as never,
      );
      expect(recoverChannelSigner(message, DOMAIN, signature)).toBe(signer.address);
    }
  });

  it('a signature over another chain, escrow or cumulative recovers someone else', async () => {
    const message = parseChannelVoucher(wire(), `0x${'00'.repeat(65)}`);
    const signature = await payer.signTypedData(channelVoucherTypedData(message, DOMAIN) as never);
    expect(recoverChannelSigner(message, { ...DOMAIN, chainId: 4663 }, signature)).not.toBe(
      payer.address,
    );
    expect(recoverChannelSigner({ ...message, cumulative: 300001n }, DOMAIN, signature)).not.toBe(
      payer.address,
    );
  });

  it('derives the key as keccak256(abi.encode(payer, signer, provider, channelId)) (I1)', () => {
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bytes32' }],
        [payer.address, delegate.address, PROVIDER, CHANNEL_ID],
      ),
    );
    expect(channelKeyOf(payer.address, delegate.address, PROVIDER, CHANNEL_ID)).toBe(expected);
    expect(channelKeyOf(payer.address, payer.address, PROVIDER, CHANNEL_ID)).not.toBe(expected);
  });

  it('refuses what the contract reverts on, before any signature work', () => {
    const sig = `0x${'00'.repeat(65)}`;
    expect(() => parseChannelVoucher(wire({ cumulative: '0' }), sig)).toThrow(/cumulative/);
    expect(() =>
      parseChannelVoucher(wire({ cumulative: (CHANNEL_MAX_CUMULATIVE + 1n).toString() }), sig),
    ).toThrow(/cumulative/);
    expect(() => parseChannelVoucher(wire({ cumulative: '01' }), sig)).toThrow(/cumulative/);
    expect(() => parseChannelVoucher(wire({ calls: 0 }), sig)).toThrow(/calls/);
    expect(() => parseChannelVoucher(wire({ calls: 1 << 24 }), sig)).toThrow(/calls/);
    expect(() => parseChannelVoucher(wire({ channelId: `0x${'00'.repeat(32)}` }), sig)).toThrow(
      /channelId/,
    );
    expect(() => parseChannelVoucher(wire({ payer: 'eip155:46630:0xabc' }), sig)).toThrow(/payer/);
    expect(() => parseChannelVoucher(wire(), '0x1234')).toThrow(/signature/);
  });

  it('time rules: life ≤ 300 s, issuedAt ≤ now + 60, at least 60 s left', () => {
    const at = (issuedAt: number, expiresAt: number) =>
      channelTimeRefusal(
        parseChannelVoucher(wire({ issuedAt, expiresAt }), `0x${'00'.repeat(65)}`),
        NOW,
      );
    expect(at(NOW, NOW + 300)).toBeNull();
    expect(at(NOW, NOW + 301)?.field).toBe('expiresAt');
    expect(at(NOW + 61, NOW + 200)?.field).toBe('issuedAt');
    expect(at(NOW - 200, NOW + 59)?.expired).toBe(true);
    expect(at(NOW - 300, NOW)?.expired).toBe(true);
  });

  it('unpacks the packed slot exactly as ChannelDoor.unpack', () => {
    const slot = {
      settled: 123456n,
      calls: 7,
      h1: 5000n,
      m1: 500_000,
      r1: 1000,
      h2: 9n,
      m2: 500_001,
      r2: 1000,
    };
    expect(unpackChannelSlot(packChannelSlot(slot))).toEqual(slot);
    // Field widths: settled u56 at bit 0, calls u24 at 56.
    expect(unpackChannelSlot((1n << 56n) - 1n).settled).toBe((1n << 56n) - 1n);
    expect(unpackChannelSlot(1n << 56n).calls).toBe(1);
    expect(toHex(packChannelSlot(slot))).toMatch(/^0x/);
  });

  it('names a bucket maturityHour << 16 | rate, and derives waived from the slim event', () => {
    expect(bucketOf(bucketId(500_000, 1000))).toEqual({ maturityHour: 500_000, takeRateBps: 1000 });
    expect(waivedOf(500n, 200n, 200n)).toBe(100n);
    expect(() => waivedOf(500n, 200n, 400n)).toThrow();
    expect(settleSkipReason(11)).toBe('NoBucket');
    expect(settleSkipReason(2)).toBe('BaseMismatch');
  });
});
