#!/usr/bin/env sh
# Refuse commits whose author or committer date is not in UTC (+0000).
#
# This repository is public, and a commit's timezone offset is published with
# it. Every commit is dated +0000; run git with TZ=UTC (e.g. `TZ=UTC git commit`,
# `TZ=UTC git merge`) or export TZ=UTC in the shell you commit from.
#
#   check-commit-utc.sh commit   — the commit about to be written (pre-commit,
#                                  pre-merge-commit): checks `git var` idents,
#                                  which honour TZ and GIT_*_DATE exactly as
#                                  the commit will.
#   check-commit-utc.sh push     — every commit a push would publish (pre-push,
#                                  ref lines on stdin): also catches commits
#                                  made by rebase, cherry-pick or amend, which
#                                  run no commit hook.
#
# Bypass only knowingly: UTC_CHECK=0 git ...
[ "${UTC_CHECK-}" = "0" ] && exit 0

fail() {
  echo "check-commit-utc: $1" >&2
  echo "check-commit-utc: commit dates must be +0000 — rerun with TZ=UTC, e.g. 'TZ=UTC git commit'." >&2
  exit 1
}

case "$1" in
  commit)
    for ident in GIT_AUTHOR_IDENT GIT_COMMITTER_IDENT; do
      offset=$(git var "$ident" | awk '{print $NF}')
      [ "$offset" = "+0000" ] || fail "$ident would be dated $offset."
    done
    ;;
  push)
    zero=0000000000000000000000000000000000000000
    bad=""
    while read -r _lref lsha _rref rsha; do
      [ "$lsha" = "$zero" ] && continue
      if [ "$rsha" = "$zero" ]; then range="$lsha --not --remotes"; else range="$rsha..$lsha"; fi
      # shellcheck disable=SC2086
      found=$(git log --format='%h %ad %cd' --date=format:%z $range | awk '$2 != "+0000" || $3 != "+0000"')
      if [ -n "$found" ]; then bad="$bad$found
"; fi
    done
    [ -z "$bad" ] || fail "these commits are not dated +0000 (rewrite them before pushing):
$bad"
    ;;
  *)
    echo "usage: check-commit-utc.sh commit|push" >&2
    exit 2
    ;;
esac
