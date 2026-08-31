#!/usr/bin/env bash
#
# End-to-end smoke check against a *deployed* OpenArtifacts worker.
#
#   OPENARTIFACTS_LICENSE_KEY=... scripts/smoke.sh https://api.openartifacts.ai
#
# It publishes a doc, reads it back from its public url, finds it in the
# publisher's list, deletes it, and confirms the url has become 410. Every step
# asserts a status code; the first surprise prints what it expected, what it got
# and the response body, and exits non-zero.
#
# Deliberately not wired into CI. It needs a real license key and a real
# deployment, and CI has neither — running it there could only ever be a red
# build for a missing credential. It is a post-deploy check a human runs.
#
# The license key comes from the environment and never leaves it: it is written
# to a curl config file inside a private temp dir rather than passed as an
# argument, because command-line arguments are visible to every process on the
# machine via `ps`. Nothing here echoes it, and the API never returns it.
set -euo pipefail

BASE_URL=${1:-${OPENARTIFACTS_BASE_URL:-}}

usage() {
  cat >&2 <<'EOF'
usage: OPENARTIFACTS_LICENSE_KEY=<paid Copilot license key> scripts/smoke.sh <base url>

  <base url>          the API host, e.g. https://api.openartifacts.ai
                      (or set OPENARTIFACTS_BASE_URL instead of passing it)
                      Document reads use the url the push returns, so the
                      serving domain is never passed in.
  OPENARTIFACTS_LICENSE_KEY   a paid license key with a push quota to spare.
                      Never passed as an argument, never printed.
EOF
  exit 2
}

[ -n "$BASE_URL" ] || usage
[ -n "${OPENARTIFACTS_LICENSE_KEY:-}" ] || usage

# Trailing slashes would double up in every url built below.
BASE_URL=${BASE_URL%/}

command -v curl >/dev/null 2>&1 || {
  echo "smoke: curl is required" >&2
  exit 2
}

umask 077
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

AUTH="$WORK/auth.curl"
BODY="$WORK/body"
# Quoted, because curl's config parser cuts an unquoted value at the first run
# of whitespace and would send a header with no key in it. `printf` is a shell
# builtin, so escaping the key for that quoting never puts it in a process's
# arguments either.
printf 'header = "Authorization: Bearer %s"\n' \
  "$(printf '%s' "$OPENARTIFACTS_LICENSE_KEY" | sed 's/[\\"]/\\&/g')" >"$AUTH"

HTTP_STATUS=""

fail() {
  printf 'smoke: %s\n' "$*" >&2
  exit 1
}

# Every request goes through one of these two, so the auth header is attached by
# the API one and structurally absent from the public one — reading a doc must
# work with no credential at all, and a smoke check that sent one anyway would
# not be checking that.
api_request() {
  method=$1
  url=$2
  shift 2
  : >"$BODY"
  HTTP_STATUS=$(curl --config "$AUTH" -sS -o "$BODY" -w '%{http_code}' \
    -X "$method" "$url" "$@") || fail "could not reach $url"
}

public_request() {
  url=$1
  shift
  : >"$BODY"
  HTTP_STATUS=$(curl -sS -o "$BODY" -w '%{http_code}' "$url" "$@") ||
    fail "could not reach $url"
}

expect_status() {
  want=$1
  what=$2
  if [ "$HTTP_STATUS" != "$want" ]; then
    printf 'FAIL  %s\n' "$what" >&2
    printf '      expected HTTP %s, got HTTP %s\n' "$want" "$HTTP_STATUS" >&2
    printf '      response body:\n' >&2
    sed 's/^/        /' "$BODY" >&2
    exit 1
  fi
  printf 'ok    %s (HTTP %s)\n' "$what" "$HTTP_STATUS"
}

expect_body() {
  needle=$1
  what=$2
  grep -q -- "$needle" "$BODY" || fail "$what: response did not contain \"$needle\""
  printf 'ok    %s\n' "$what"
}

# Enough of a JSON reader for four flat string fields, so the check needs
# nothing installed beyond curl. The API's responses come from JSON.stringify,
# so they are compact and unescaped for these fields.
json_string() {
  grep -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$BODY" |
    head -n 1 |
    sed -E 's/.*:[[:space:]]*"//; s/"$//'
}

# Marks the doc this run published, so the read-back is checking our own bytes
# rather than any doc happening to be there.
MARKER="openartifacts-smoke-$(date -u +%Y%m%dT%H%M%SZ)-$$"

cat >"$WORK/push.json" <<EOF
{"title":"OpenArtifacts smoke check $MARKER",
 "html":"<!doctype html><html lang=en><head><meta charset=utf-8><title>smoke</title></head><body><p>$MARKER</p></body></html>"}
EOF

printf 'smoke: %s\n\n' "$BASE_URL"

public_request "$BASE_URL/health"
expect_status 200 "GET /health"

api_request POST "$BASE_URL/api/v1/docs" \
  -H 'content-type: application/json' \
  --data-binary "@$WORK/push.json"
expect_status 201 "POST /api/v1/docs"

DOC_ID=$(json_string docId)
DOC_URL=$(json_string url)
[ -n "$DOC_ID" ] || fail "push response carried no docId"
[ -n "$DOC_URL" ] || fail "push response carried no url"
printf '      docId %s\n      url   %s\n' "$DOC_ID" "$DOC_URL"

public_request "$DOC_URL"
expect_status 200 "GET $DOC_URL"
expect_body "$MARKER" "the page serves the bytes that were pushed"
expect_body "Copilot for Obsidian</span>" "the page carries the header byline"
expect_body "openartifacts.ai</a>" "the page carries the footer byline, linked"
expect_body 'rel="icon"' "the page carries a tab icon"

api_request GET "$BASE_URL/api/v1/docs?limit=100"
expect_status 200 "GET /api/v1/docs"
expect_body "$DOC_ID" "the new doc appears in the publisher's list"

api_request DELETE "$BASE_URL/api/v1/docs/$DOC_ID"
expect_status 204 "DELETE /api/v1/docs/$DOC_ID"

public_request "$DOC_URL"
expect_status 410 "GET $DOC_URL after delete"

printf '\nsmoke: all steps passed\n'
