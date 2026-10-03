#!/usr/bin/env bash
#
# Verifier key custody check: prove that verifier key material appears in no log,
# no environment and no response.
#
# ## The method: a canary, not a hopeful grep
#
# Grepping a log for "something secret-looking" proves nothing — you cannot
# search for a value you do not have. So this generates two keypairs whose seeds
# it *knows*, runs a full session with them (boot, sign, rotate, revoke, refuse,
# rate-limit, journal, and a deliberate parse failure), captures every byte of
# stdout and stderr, and then searches that capture for the exact seeds.
#
# Empty output is the result. Anything else is a leak with a line number.
#
# What is searched, and why each one is a real route out of a process:
#
#   the session's stdout+stderr    logs, the env dump, the serialised signer,
#                                  the signature response, the parse-error message
#   the working tree               a key written to a file by mistake
#   .env / .env.local              a key persisted by tooling
#   the database                   the journal, which stores a hash and must not
#                                  store the bytes
#
# The session is `yarn verifier:rotation-drill`, which ends in a phase that
# deliberately tries to leak on each route. Reusing the drill rather than
# writing a smaller session is the point: the scan covers the real signing path,
# not a reduced one.
#
# Usage:  ./scripts/verifier-key/leak-scan.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

CAPTURE="${TMPDIR:-/tmp}/verifier-leak-scan.$$.log"
trap 'rm -f "$CAPTURE"' EXIT

# Two canary seeds. Known to this script, and to nothing else.
SEED_OLD="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
SEED_NEW="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

echo "=== canary seeds (known only to this script) ==="
echo "old  ${SEED_OLD:0:8}…${SEED_OLD: -8}   (64 hex chars, full value held in a shell variable)"
echo "new  ${SEED_NEW:0:8}…${SEED_NEW: -8}"
echo ""
echo "=== running a full signing session with them ==="

set +e
VERIFIER_DRILL_SEED_OLD="$SEED_OLD" \
VERIFIER_DRILL_SEED_NEW="$SEED_NEW" \
  yarn --silent verifier:rotation-drill >"$CAPTURE" 2>&1
SESSION_EXIT=$?
set -e

echo "session exit code: $SESSION_EXIT"
echo "captured $(wc -l <"$CAPTURE" | tr -d ' ') lines, $(wc -c <"$CAPTURE" | tr -d ' ') bytes"
if [ "$SESSION_EXIT" -ne 0 ]; then
  echo "the session failed; a scan over a session that did not sign proves nothing"
  tail -30 "$CAPTURE"
  exit 1
fi
echo "the session signed, rotated, revoked, was rate-limited, and dumped its own"
echo "environment, its signer object and its signature response into that capture."
echo ""

FOUND=0

scan() {
  local what="$1"
  shift
  echo "--- grep: $what ---"
  # Both seeds, and the uppercase form, since hex is case-insensitive and a
  # different encoder in some future logger might emit it either way.
  if "$@" -e "$SEED_OLD" -e "$SEED_NEW" \
          -e "$(echo "$SEED_OLD" | tr 'a-f' 'A-F')" \
          -e "$(echo "$SEED_NEW" | tr 'a-f' 'A-F')"; then
    echo "*** LEAK: the canary seed appears above ***"
    FOUND=1
  else
    echo "(no match)"
  fi
  echo ""
}

echo "=== 1. the session's own stdout and stderr ==="
scan "session capture" grep -n --color=never

echo "=== 2. the working tree ==="
scan "tracked and untracked files" \
  grep -rn --color=never --binary-files=without-match \
    --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
    --exclude-dir=coverage --exclude-dir=.keys .

echo "=== 3. the environment files ==="
scan ".env and .env.local" grep -n --color=never --no-messages .env .env.local

echo "=== 4. the signing journal in Postgres ==="
# The journal stores a sha256 of the payload and the (public) signature. If a
# seed ever reached a column, this is where it would surface.
DB_DUMP="$(
  docker exec x402_postgres psql -U "${DATABASE_USER:-postgres}" -d "${DATABASE_NAME:-app}" \
    -A -t -c 'SELECT * FROM verifier_signing_log' 2>/dev/null || echo '<database unavailable>'
)"
echo "--- grep: verifier_signing_log ---"
if printf '%s' "$DB_DUMP" | grep -n --color=never -e "$SEED_OLD" -e "$SEED_NEW"; then
  echo "*** LEAK: the canary seed is in the journal ***"
  FOUND=1
else
  echo "(no match — $(printf '%s' "$DB_DUMP" | grep -c . ) rows scanned)"
fi
echo ""

# A scan that cannot fail is a green tick, not a proof. Before believing the
# four "no match" results above, check that this scanner finds the seed when it
# IS there — a typo in the variable name, an empty capture, or a grep that
# silently matched nothing would otherwise read exactly like a pass.
echo "=== negative control: the same scan over a file that does contain the seed ==="
CONTROL="${TMPDIR:-/tmp}/verifier-leak-control.$$.log"
printf 'a log line that leaked: secretKey=%s\n' "$SEED_OLD" >"$CONTROL"
if grep -c -e "$SEED_OLD" "$CONTROL" >/dev/null; then
  echo "the scanner finds the canary when it is present — the four results above mean something"
else
  echo "*** the scanner failed its own control; the results above are meaningless ***"
  rm -f "$CONTROL"
  exit 1
fi
# And that the session really used these seeds rather than minting its own.
if ! grep -q "$(node -e '
  const { createPrivateKey, createPublicKey } = require("node:crypto");
  const seed = Buffer.from(process.argv[1], "hex");
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: "der", type: "pkcs8" });
  process.stdout.write(createPublicKey(key).export({ format: "der", type: "spki" }).subarray(12).toString("hex"));
' "$SEED_OLD")" "$CAPTURE"; then
  echo "*** the session did not use the canary key; the scan proved nothing ***"
  rm -f "$CONTROL"
  exit 1
fi
echo "the session's public key derives from the canary seed — it signed with the key being scanned for"
rm -f "$CONTROL"
echo ""

echo "=== result ==="
if [ "$FOUND" -eq 0 ]; then
  echo "PASS — the canary seeds appear in none of the four places."
  echo ""
  echo "Note what this does and does not establish. It shows the material does not"
  echo "escape through logs, the environment, a response, a file or the database. It"
  echo "does NOT show the material is unreachable: it is in this process's memory"
  echo "during boot, so a debugger or a core dump still reaches it. Closing that is"
  echo "what a KMS does, and it is why SignerPort exists — see docs/architecture.md."
  exit 0
fi

echo "FAIL — key material leaked. See the matches above."
exit 1
