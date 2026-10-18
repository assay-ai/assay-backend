import { createHash } from 'node:crypto';

/**
 * RFC 9421 style signature base for outbound provider requests.
 *
 * Pure: no clock, no randomness, no keys. The format is a contract that every
 * provider SDK re-implements; `test/fixtures/request-signing/v1.json` pins it
 * byte for byte.
 */

export interface SignableRequest {
  method: string;
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
}

export interface SignatureParams {
  created: number;
  expires: number;
  nonce: string;
  keyId: string;
}

const CALL_ID_HEADER = 'x-assay-call-id';
const DIGEST_HEADER = 'content-digest';
const SIGNATURE_TAG = 'assay-request';

/** `sha-256=:<base64(sha256(utf-8 body))>:` */
export function contentDigest(body: string): string {
  return `sha-256=:${createHash('sha256').update(Buffer.from(body, 'utf8')).digest('base64')}:`;
}

/** Covered components in signing order; `content-digest` only when there is a body. */
export function coveredComponents(hasBody: boolean): string[] {
  return [
    '@method',
    '@authority',
    '@path',
    '@query',
    ...(hasBody ? [DIGEST_HEADER] : []),
    CALL_ID_HEADER,
  ];
}

/** `("@method" ...);created=...;expires=...;nonce="...";keyid="...";alg="ed25519";tag="assay-request"` */
export function signatureParamsValue(components: string[], p: SignatureParams): string {
  const list = `(${components.map((c) => `"${c}"`).join(' ')})`;
  return (
    `${list};created=${p.created};expires=${p.expires};nonce="${p.nonce}"` +
    `;keyid="${p.keyId}";alg="ed25519";tag="${SIGNATURE_TAG}"`
  );
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  throw new Error(`signature base: missing covered header "${name}"`);
}

/** `req.headers` must already contain `content-digest` when `body !== undefined`. */
export function signatureBase(req: SignableRequest, p: SignatureParams): string {
  const url = new URL(req.url);
  const hasBody = req.body !== undefined;
  const components = coveredComponents(hasBody);

  const lines = components.map((name) => {
    switch (name) {
      case '@method':
        return `"@method": ${req.method.toUpperCase()}`;
      case '@authority':
        // `URL.host` is lowercase and omits the scheme's default port.
        return `"@authority": ${url.host.toLowerCase()}`;
      case '@path':
        return `"@path": ${url.pathname === '' ? '/' : url.pathname}`;
      case '@query':
        return `"@query": ?${url.search.startsWith('?') ? url.search.slice(1) : url.search}`;
      default:
        return `"${name}": ${headerValue(req.headers, name)}`;
    }
  });
  lines.push(`"@signature-params": ${signatureParamsValue(components, p)}`);
  return lines.join('\n');
}
