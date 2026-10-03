/**
 * Thin, generic HTTP client for the devnet acceptance suite.
 *
 * No dependency on this codebase's Nest app, database, or chain code — it is
 * a plain `fetch` wrapper the suite's steps point at the live devnet API
 * server (e.g. `http://127.0.0.1:3000`), typically with a bearer token minted
 * by `acceptance-identity.ts`. It doesn't import that file, though —
 * the two are independent.
 *
 * **Load-bearing assumption:** every *successful* response is wrapped by
 * `TransformInterceptor` as `{ data, statusCode, message }` (see
 * `docs/architecture.md` §"Controller Pattern") — `request()` unwraps `data`
 * unconditionally. Confirmed live against a running API server:
 *
 *   GET /api/v1/health  -> 200 {"data":{"success":true,"message":"..."},"statusCode":200,"message":"Success"}
 *   GET /api/v1/agents  -> 401 {"success":false,"error":{"code":"MCP_CREDENTIAL_INVALID",...}}
 *
 * Error responses do NOT carry a `data` field at all — they carry
 * `{ success: false, error: {...} }` per `docs/architecture.md` §"Error
 * Response Format" — so `AcceptanceHttpError`'s `body` is that whole error
 * envelope, not an unwrapped value. Pointing this client at an endpoint that
 * returns something other than these two shapes (a raw array, a redirect, an
 * HTML error page) will throw a confusing error or silently unwrap the wrong
 * field — it is not general-purpose, it is shaped for this backend only.
 */
export class AcceptanceHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    method: string,
    path: string,
  ) {
    super(`${method} ${path} -> ${status}: ${JSON.stringify(body)}`);
  }
}

export function createApiClient(baseUrl: string, token?: string) {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => undefined);
    if (!res.ok) throw new AcceptanceHttpError(res.status, json, method, path);
    // TransformInterceptor wraps every success as { data, statusCode, message } —
    // see docs/architecture.md "Controller Pattern". Unwrap it here, once.
    return (json as { data: T }).data;
  }
  return {
    get: <T>(path: string) => request<T>('GET', path),
    post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
    put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  };
}
