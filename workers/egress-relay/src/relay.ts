export interface RelayEnv {
  RELAY_TOKEN: string;
  RELAY_TOKEN_NEXT?: string;
  ALLOW_HTTP?: string;
}

/** Ports Cloudflare proxies for HTTPS; the Worker runtime only reaches these. */
export const RELAY_ALLOWED_PORTS: readonly number[] = [443, 8443, 2053, 2083, 2087, 2096];

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_HEADERS = 64;
const MAX_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

const DROP_EXACT = new Set([
  'host',
  'x-real-ip',
  'forwarded',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const DROP_PREFIX = ['cf-', 'x-forwarded-', 'proxy-'];

// Hop-by-hop headers removed from the provider's answer.
const RESPONSE_DROP = new Set([
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
]);

type ErrorKind =
  | 'UNAUTHORIZED'
  | 'BAD_REQUEST'
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'CONNECT'
  | 'TOO_LARGE';

function relayError(kind: ErrorKind): Response {
  return new Response(JSON.stringify({ kind }), {
    status: 502,
    headers: { 'content-type': 'application/json', 'x-assay-relay': 'error' },
  });
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

async function authorized(request: Request, env: RelayEnv): Promise<boolean> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/i.exec(header);
  const presented = await digest(match ? match[1] : '');
  let ok = 0;
  for (const token of [env.RELAY_TOKEN, env.RELAY_TOKEN_NEXT]) {
    if (!token) continue;
    const expected = await digest(token);
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ presented[i];
    ok |= diff === 0 ? 1 : 0;
  }
  return ok === 1;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.startsWith('[')) return true;
  // The URL parser normalises decimal/hex/octal/short forms to dotted IPv4.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true;
  // Defence in depth if a parser leaves a numeric form un-normalised: no TLD is numeric or hex-prefixed.
  const last = hostname.replace(/\.$/, '').split('.').pop() ?? '';
  return /^(0x[0-9a-f]*|\d+)$/i.test(last);
}

interface Envelope {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  timeoutMs: number;
  maxResponseBytes: number;
}

function parseEnvelope(raw: unknown): Envelope | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.url !== 'string' || typeof e.method !== 'string') return null;
  if (typeof e.headers !== 'object' || e.headers === null || Array.isArray(e.headers)) return null;
  const headers = e.headers as Record<string, unknown>;
  for (const v of Object.values(headers)) if (typeof v !== 'string') return null;
  if (e.body !== null && e.body !== undefined && typeof e.body !== 'string') return null;
  if (!Number.isInteger(e.timeoutMs) || (e.timeoutMs as number) <= 0) return null;
  if (!Number.isInteger(e.maxResponseBytes) || (e.maxResponseBytes as number) <= 0) return null;
  return {
    url: e.url,
    method: e.method.toUpperCase(),
    headers: headers as Record<string, string>,
    body: (e.body as string | null | undefined) ?? null,
    timeoutMs: Math.min(e.timeoutMs as number, MAX_TIMEOUT_MS),
    maxResponseBytes: Math.min(e.maxResponseBytes as number, MAX_RESPONSE_BYTES),
  };
}

function buildHeaders(input: Record<string, string>): Headers | null {
  const out = new Headers();
  try {
    for (const [name, value] of Object.entries(input)) {
      const lower = name.toLowerCase();
      if (DROP_EXACT.has(lower) || DROP_PREFIX.some((p) => lower.startsWith(p))) continue;
      out.set(name, value);
    }
  } catch {
    return null;
  }
  return out;
}

function limitBody(body: ReadableStream<Uint8Array>, max: number): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) {
          controller.error(new Error('TOO_LARGE'));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

export async function handleRelay(
  request: Request,
  env: RelayEnv,
  fetchImpl: typeof fetch,
): Promise<Response> {
  if (!(await authorized(request, env))) return relayError('UNAUTHORIZED');

  let envelope: Envelope | null;
  try {
    envelope = parseEnvelope(await request.json());
  } catch {
    return relayError('BAD_REQUEST');
  }
  if (!envelope || !ALLOWED_METHODS.has(envelope.method)) return relayError('BAD_REQUEST');
  if (Object.keys(envelope.headers).length > MAX_HEADERS) return relayError('BAD_REQUEST');

  let target: URL;
  try {
    target = new URL(envelope.url);
  } catch {
    return relayError('BAD_REQUEST');
  }
  const httpOk = env.ALLOW_HTTP === '1' && target.protocol === 'http:';
  if (target.protocol !== 'https:' && !httpOk) return relayError('BLOCKED_TARGET');
  if (target.username || target.password) return relayError('BLOCKED_TARGET');
  if (isIpLiteral(target.hostname)) return relayError('BLOCKED_TARGET');
  if (target.port !== '' && !RELAY_ALLOWED_PORTS.includes(Number(target.port)) && !httpOk) {
    return relayError('BLOCKED_TARGET');
  }

  const headers = buildHeaders(envelope.headers);
  if (!headers) return relayError('BAD_REQUEST');

  const hasBody = envelope.body !== null && envelope.method !== 'GET' && envelope.method !== 'HEAD';
  let upstream: Response;
  try {
    upstream = await fetchImpl(target.toString(), {
      method: envelope.method,
      headers,
      body: hasBody ? envelope.body : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(envelope.timeoutMs),
    });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    return relayError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'CONNECT');
  }

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > envelope.maxResponseBytes) {
    void upstream.body?.cancel().catch(() => undefined);
    return relayError('TOO_LARGE');
  }

  const out = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!RESPONSE_DROP.has(name.toLowerCase())) out.append(name, value);
  });
  out.set('x-assay-relay', 'upstream');
  const body = upstream.body ? limitBody(upstream.body, envelope.maxResponseBytes) : null;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}
