/**
 * The bytes a verifier signs.
 *
 * `packages/settlement-client/src/attestation-message.ts` is the one part of the
 * settlement program's interface that cannot be generated: the signed message is
 * neither an instruction nor an account, so it is nowhere in the IDL. This suite
 * is what stops "hand-written" from also meaning "unchecked".
 *
 * It pins the layout assay-solana's `programs/x402-payment/src/attestation.rs` declares, at the
 * literal offsets that file writes to — which is deliberate duplication, and the
 * same duplication the program's own `const _: () = assert!` lines exist for:
 * two independent statements of one layout, so a change to either has to be
 * matched rather than assumed.
 *
 * What this suite does **not** claim: that the offsets are right. Only the
 * program can say that, and it does — it recomputes the message and refuses a
 * signature over anything else with `MissingVerifierSignature`. That check runs
 * for real in `scripts/settlement/exercise-all.ts`, where `propose_slash` lands
 * against a live cluster. This file is the fast lock; that run is the true one.
 *
 * Lean v3 leaves **one** verifier-signed message. The cancel attestation went
 * with `cancel_slash` becoming the admin's instruction, and the reversal one
 * with `reverse_slash` being deleted outright; the voucher (240 bytes,
 * `voucher-message.spec.ts`) is the other signed message and the buyer signs
 * that one.
 */
import { address, getAddressEncoder } from '@solana/kit';
import {
  ATTESTATION_DOMAINS,
  ResponseClass,
  SETTLEMENT_PROGRAM_ADDRESS,
  SIGNED_RESPONSE_CLASS,
  SLASH_MESSAGE_LENGTH,
  slashAttestationMessage,
  VOUCHER_MESSAGE_LENGTH,
} from '@assay/settlement-client';

const PROVIDER = address('74GakfrcEvE7qh9LzB7hf4JZgE9eu1yDEZTYqSWWbB1a');
const BENEFICIARY = address('BPFLoaderUpgradeab1e11111111111111111111111');
const REQUEST_ID = new Uint8Array(32).fill(0xa1);
const POLICY = new Uint8Array(32).fill(0xb2);
const ISSUED_AT = 1_760_000_000n;
const EXPIRES_AT = 1_760_086_400n;

const slash = () =>
  slashAttestationMessage({
    requestId: REQUEST_ID,
    provider: PROVIDER,
    beneficiary: BENEFICIARY,
    status: SIGNED_RESPONSE_CLASS.dataFail,
    penalty: 2_000_000n,
    policy: POLICY,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
  });

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function u64At(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

describe('attestation signed messages', () => {
  describe('lengths', () => {
    it('matches the length attestation.rs asserts', () => {
      expect(slash()).toHaveLength(SLASH_MESSAGE_LENGTH);
      expect(SLASH_MESSAGE_LENGTH).toBe(211);
    });

    it('stays distinct from the voucher message', () => {
      // The program leans on this: `attestation.rs` asserts
      // `ATTESTATION_MESSAGE_LEN != VOUCHER_MESSAGE_LEN` at compile time, and a
      // `data.len()` check rejects a cross-kind message before any field
      // comparison happens — so the domain tags are the second lock rather than
      // the only one.
      expect(SLASH_MESSAGE_LENGTH).not.toBe(VOUCHER_MESSAGE_LENGTH);
      expect([SLASH_MESSAGE_LENGTH, VOUCHER_MESSAGE_LENGTH]).toEqual([211, 240]);
    });
  });

  describe('domain separation', () => {
    it('prefixes the message with its own tag', () => {
      expect(text(slash().subarray(0, 26))).toBe('assay:slash-attestation:v1');
    });

    it('exports the same tag it writes', () => {
      expect(Array.from(ATTESTATION_DOMAINS.slash)).toEqual(Array.from(slash().subarray(0, 26)));
    });

    it('carries exactly one domain, since the contract has one signed attestation', () => {
      expect(Object.keys(ATTESTATION_DOMAINS)).toEqual(['slash']);
    });

    it('binds the message to the program id', () => {
      // Without this, a signature produced for a devnet deployment would be
      // valid against a mainnet one at the same seeds.
      const programBytes = Array.from(slash().subarray(26, 58));

      const other = address('11111111111111111111111111111111');
      const elsewhere = slashAttestationMessage({
        requestId: REQUEST_ID,
        provider: PROVIDER,
        beneficiary: BENEFICIARY,
        status: SIGNED_RESPONSE_CLASS.dataFail,
        penalty: 2_000_000n,
        policy: POLICY,
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
        programAddress: other,
      });
      expect(Array.from(elsewhere.subarray(26, 58))).not.toEqual(programBytes);
    });

    it('defaults to the program the client was generated for', () => {
      expect(Array.from(slash().subarray(26, 58))).toEqual(
        Array.from(getAddressEncoder().encode(SETTLEMENT_PROGRAM_ADDRESS)),
      );
    });
  });

  describe('field offsets', () => {
    it('writes the slash message at attestation.rs’s offsets', () => {
      const message = slash();
      expect(Array.from(message.subarray(58, 90))).toEqual(Array.from(REQUEST_ID));
      expect(message[154]).toBe(SIGNED_RESPONSE_CLASS.dataFail);
      expect(u64At(message, 155)).toBe(2_000_000n);
      expect(Array.from(message.subarray(163, 195))).toEqual(Array.from(POLICY));
      expect(u64At(message, 195)).toBe(ISSUED_AT);
      expect(u64At(message, 203)).toBe(EXPIRES_AT);
    });

    it('writes the provider and beneficiary where attestation.rs reads them', () => {
      const message = slash();
      expect(Array.from(message.subarray(26, 58))).toEqual(
        Array.from(getAddressEncoder().encode(SETTLEMENT_PROGRAM_ADDRESS)),
      );
      expect(Array.from(message.subarray(90, 122))).toEqual(
        Array.from(getAddressEncoder().encode(PROVIDER)),
      );
      expect(Array.from(message.subarray(122, 154))).toEqual(
        Array.from(getAddressEncoder().encode(BENEFICIARY)),
      );
    });

    it('is the sum of its own field widths', () => {
      expect(SLASH_MESSAGE_LENGTH).toBe(26 + 32 + 32 + 32 + 32 + 1 + 8 + 32 + 8 + 8);
    });
  });

  describe('the signed status byte', () => {
    it('agrees with the generated ResponseClass enum', () => {
      // `signed_message` serialises the discriminant explicitly so that
      // reordering the Rust enum cannot silently change what a signature means.
      // These two therefore have to be asserted equal rather than shared.
      expect(SIGNED_RESPONSE_CLASS.pass).toBe(ResponseClass.Pass);
      expect(SIGNED_RESPONSE_CLASS.systemError).toBe(ResponseClass.SystemError);
      expect(SIGNED_RESPONSE_CLASS.requestError).toBe(ResponseClass.RequestError);
      expect(SIGNED_RESPONSE_CLASS.dataFail).toBe(ResponseClass.DataFail);
    });

    it('is what separates a slashable judgement from a payable one', () => {
      const dataFail = slash();
      const asPass = slashAttestationMessage({
        requestId: REQUEST_ID,
        provider: PROVIDER,
        beneficiary: BENEFICIARY,
        status: SIGNED_RESPONSE_CLASS.pass,
        penalty: 2_000_000n,
        policy: POLICY,
        issuedAt: ISSUED_AT,
        expiresAt: EXPIRES_AT,
      });

      // One byte, inside the signature. The platform cannot relabel a judgement
      // to move it between rows of the verdict table.
      expect(dataFail[154]).not.toBe(asPass[154]);
      expect(Buffer.compare(Buffer.from(dataFail), Buffer.from(asPass))).not.toBe(0);
    });
  });

  describe('fixed-width fields', () => {
    it('refuses a request id that is not 32 bytes', () => {
      // Padding it would sign a message the caller did not mean, and the program
      // would refuse with MissingVerifierSignature — which sends the reader to
      // look at key registration rather than at a 31-byte id.
      expect(() =>
        slashAttestationMessage({
          requestId: new Uint8Array(31),
          provider: PROVIDER,
          beneficiary: BENEFICIARY,
          status: SIGNED_RESPONSE_CLASS.dataFail,
          penalty: 2_000_000n,
          policy: POLICY,
          issuedAt: ISSUED_AT,
          expiresAt: EXPIRES_AT,
        }),
      ).toThrow(/exactly 32 bytes, got 31/);
    });

    it('refuses a policy hash that is not 32 bytes', () => {
      expect(() =>
        slashAttestationMessage({
          requestId: REQUEST_ID,
          provider: PROVIDER,
          beneficiary: BENEFICIARY,
          status: SIGNED_RESPONSE_CLASS.dataFail,
          penalty: 2_000_000n,
          policy: new Uint8Array(33),
          issuedAt: ISSUED_AT,
          expiresAt: EXPIRES_AT,
        }),
      ).toThrow(/exactly 32 bytes, got 33/);
    });
  });
});
