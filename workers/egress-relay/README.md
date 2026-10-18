# assay-egress-relay

Cloudflare Worker that relays the backend's outbound calls to provider URLs, so providers never see the backend's IP.

Protocol v1: `POST /v1/relay` with `authorization: Bearer <token>` and a JSON envelope
`{ url, method, headers, body, timeoutMs, maxResponseBytes }`. A provider answer (including 3xx, never followed) is returned as-is with `x-assay-relay: upstream`. A relay failure is `502` with `x-assay-relay: error` and `{ "kind": ... }` (`UNAUTHORIZED`, `BAD_REQUEST`, `BLOCKED_TARGET`, `TIMEOUT`, `CONNECT`, `TOO_LARGE`).

Targets: https only (http when `ALLOW_HTTP="1"`, local tests), no IP literals, no userinfo, ports 443/8443/2053/2083/2087/2096, methods GET/HEAD/POST/PUT/PATCH/DELETE, at most 64 headers.

## Develop

    npm ci
    npm test
    npx wrangler deploy --dry-run

## Deploy

1. `npx wrangler login` (once, by the operator).
2. Generate a token: `openssl rand -hex 32`.
3. `npx wrangler secret put RELAY_TOKEN` and paste the token.
4. Uncomment and edit the custom-domain route in `wrangler.toml`.
5. `npx wrangler deploy`.
6. Set `EGRESS_RELAY_URL` (for example `https://egress.<domain>`) and `EGRESS_RELAY_TOKEN` on the backend.

## Rotate the token

1. `wrangler secret put RELAY_TOKEN_NEXT` with the new token; the Worker now accepts both.
2. Switch the backend `EGRESS_RELAY_TOKEN` to the new token and restart it.
3. `wrangler secret put RELAY_TOKEN` with the new token, then `wrangler secret delete RELAY_TOKEN_NEXT`.
