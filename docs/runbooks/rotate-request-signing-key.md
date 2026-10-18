# Runbook: rotate the request signing key

**What it decides:** which Ed25519 key signs calls to provider endpoints
(`PROVIDER_REQUEST_SIGNING_KEYS`, first entry signs). Every listed public key is published
at `/.well-known/assay-request-keys.json` with `Cache-Control: max-age=3600`, and
providers' verifiers cache it. Design: `docs/adr/0002-provider-request-auth.md`.

Set the variable on BOTH the `api` and `mcp` processes, always with the same value: a
process with a different list signs with another key or publishes the wrong JWKS. The
`api` process serves the JWKS; the `mcp` process signs.

## Steps

1. Generate a 32-byte Ed25519 seed: `openssl rand -hex 32`. The entry is
   `{"keyId":"req-2026-11","secretKey":"<that hex>"}`. Choose a new `keyId`; never reuse one.
2. Publish first: deploy with the new key SECOND: `[old, new]`. The old key still signs;
   the JWKS now lists both public keys.
3. Wait at least 1 hour (the JWKS cache lifetime), longer if providers are known to cache
   more. Check `curl https://<api host>/.well-known/assay-request-keys.json` lists the
   new `kid`.
4. Make the new key first: `[new, old]`. New calls are signed by `new`; calls signed by
   `old` a moment ago still verify, because `old` is still published.
5. After at least 1 hour more (signatures live 300 s, plus verifier caches), remove the
   old key: `[new]`.

Never make a key first before it has been published for an hour: a verifier with a cached
JWKS would reject every call as `unknown keyid`, and those failures would look like the
provider's fault to the provider.

## If something goes wrong

- Providers report `unknown keyid`: put the previous key first again (it is still in the
  list or in the secret store) and wait for the cache to expire.
- A key is compromised: skip the waiting, put a new key first and remove the compromised
  one from the list (and so from the JWKS) in the same deploy, immediately. Providers can
  keep the old JWKS cached for up to 1 hour, so signatures from the compromised key are
  still accepted by them until their cache expires; tell providers to refresh the JWKS.
  A shorter cache lifetime is a verifier SDK option and is tracked in the
  `assay-provider-verify` repository, not here.

Credential headers are not covered by the signature and rely on TLS; a signing-key
compromise does not expose them.
