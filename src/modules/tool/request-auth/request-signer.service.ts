import { Inject, Injectable, Logger } from '@nestjs/common';
import { createPrivateKey, createPublicKey, randomBytes, sign, KeyObject } from 'node:crypto';

import type { EnvSigningKeySource } from '@modules/verification/signing/backends/env-key-source';

import { REQUEST_SIGNING_KEYS } from './request-signing.keys';
import {
  contentDigest,
  coveredComponents,
  signatureBase,
  signatureParamsValue,
  SignableRequest,
  SignatureParams,
} from './signature-base';

export const REQUEST_SIGNING_TAG = 'assay-request';
export const REQUEST_SIGNATURE_TTL_S = 300;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export interface RequestJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  kid: string;
  use: 'sig';
  alg: 'EdDSA';
}

/**
 * Signs outbound provider requests (Ed25519, RFC 9421 style) with the first
 * configured key and publishes every configured public key as a JWKS.
 */
@Injectable()
export class RequestSignerService {
  private readonly logger = new Logger(RequestSignerService.name);
  private readonly active: { keyId: string; key: KeyObject } | null;
  private readonly jwk: RequestJwk[];

  constructor(@Inject(REQUEST_SIGNING_KEYS) keys: readonly EnvSigningKeySource[]) {
    if (keys.length === 0 && process.env.NODE_ENV === 'production') {
      throw new Error('PROVIDER_REQUEST_SIGNING_KEYS is required in production');
    }
    if (keys.length === 0) {
      this.logger.warn('No request signing keys configured; outbound requests are unsigned');
    }
    const loaded = keys.map((source) => {
      const key = createPrivateKey({
        key: Buffer.concat([PKCS8_ED25519_PREFIX, source.seed]),
        format: 'der',
        type: 'pkcs8',
      });
      const x = createPublicKey(key).export({ format: 'jwk' }).x as string;
      return { keyId: source.keyId, key, x };
    });
    this.active = loaded[0] ?? null;
    this.jwk = loaded.map((k) => ({
      kty: 'OKP',
      crv: 'Ed25519',
      x: k.x,
      kid: k.keyId,
      use: 'sig',
      alg: 'EdDSA',
    }));
  }

  /** Returns the headers to add (`content-digest` only when `body !== undefined`). */
  async sign(req: SignableRequest, now: Date = new Date()): Promise<Record<string, string>> {
    if (!this.active) return {};
    const created = Math.floor(now.getTime() / 1000);
    return this.signWith(req, {
      created,
      expires: created + REQUEST_SIGNATURE_TTL_S,
      nonce: randomBytes(16).toString('base64url'),
      keyId: this.active.keyId,
    });
  }

  /** Deterministic core, used by `sign()` and the test-vector generator. */
  signWith(req: SignableRequest, params: SignatureParams): Record<string, string> {
    if (!this.active) return {};
    const out: Record<string, string> = {};
    let headers = req.headers;
    if (req.body !== undefined) {
      out['Content-Digest'] = contentDigest(req.body);
      headers = { ...headers, 'content-digest': out['Content-Digest'] };
    }
    const base = signatureBase({ ...req, headers }, params);
    const signature = sign(null, Buffer.from(base, 'utf8'), this.active.key).toString('base64');
    out['Signature-Input'] =
      `assay=${signatureParamsValue(coveredComponents(req.body !== undefined), params)}`;
    out['Signature'] = `assay=:${signature}:`;
    return out;
  }

  jwks(): { keys: RequestJwk[] } {
    return { keys: this.jwk.map((k) => ({ ...k })) };
  }
}
