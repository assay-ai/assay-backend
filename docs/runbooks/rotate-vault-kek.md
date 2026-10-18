# Runbook: rotate the credential vault KEK

**What it decides:** which key wraps the data keys of provider credentials
(`CREDENTIAL_VAULT_KEKS`, first entry is active). Design: `docs/adr/0002-provider-request-auth.md`.

Set the variable on BOTH the `api` and `mcp` processes, always with the same value: the
`mcp` process opens the credentials to dial providers and the `api` process writes them.
In production an empty variable fails the boot, and so does a key id that now holds
different bytes than the ones first seen for it (`vault_kek_checks`); the message names the
key id, never the key.

## Steps

1. Generate a new 32-byte key: `openssl rand -hex 32`. Choose a new `keyId` (at most 64
   characters, never reused).
2. Deploy with the new key FIRST and the old key still listed:
   `[{"keyId":"k2","key":"<new>"},{"keyId":"k1","key":"<old>"}]`. New writes use `k2`;
   existing rows under `k1` still open.
3. Re-wrap the existing rows (one environment at a time, with the same variable and the
   production `DATABASE_*` settings):
   `yarn ts-node -T -r tsconfig-paths/register scripts/vault/rewrap-deks.ts`
   It prints `rewrap: rewrapped=N already_active=M failed=F` and never any key material.
   It is safe to re-run.
4. `failed` must be 0 (a non-zero count exits 1: those rows name a KEK that is not loaded
   or failed authentication). Verify: `SELECT kek_id, count(*) FROM binding_credentials GROUP BY 1`
   shows only `k2`.
5. Deploy again without `k1`. Keep `k1` in the secret store until a call through a
   credentialed binding has succeeded on `k2`.

## If something goes wrong

- Calls fail with `credentialVaultUnavailable`: a row's KEK is not loaded. Put the missing key
  back in the list; nothing was lost.
- The boot fails with `Vault key "<kid>" does not match the key-check value`: a key id was
  reused with different material. Restore the original key for that id, or choose a new id
  (and re-wrap). Only if the old key is gone for good and its rows are unwanted, delete the
  row from `vault_kek_checks` for that id.
- A key that is gone for good loses the credentials it wrapped; the affected providers
  must set them again through the credentials API.
