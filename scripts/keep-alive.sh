#!/usr/bin/env bash
# Keeps the Supabase Free project awake (T-036; run daily by .github/workflows/keep-alive.yml,
# docs/08-free-tier.md §6.1). One POST /rest/v1/rpc/keep_alive with the public anon (or
# publishable) key: a Data API request that reads and writes the database.
#
#   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_ANON_KEY=<key> scripts/keep-alive.sh
#
# Exit 0: the project answered (or nothing is configured: both variables empty, a notice).
# Exit 1, with a GitHub Actions ::error:: line naming the cause:
#   540  the project is PAUSED (restore it in the dashboard)
#   402  Supabase restricted it (over the Free quotas)
#   200 + read_only  the database is read-only (over the Free plan's 500 MB)
#   401/403 wrong key · 404 wrong URL or migrations missing · no answer · anything else
# Optional: JITTER_MAX_S (sleep 0..n-1 s first; default 0), KEEP_ALIVE_MAX_TIME (s per try,
# default 30), KEEP_ALIVE_RETRY_DELAY (s, default 15), KEEP_ALIVE_ALLOW_HTTP=1 (tests only).
# Never prints the key.
set -euo pipefail

url="${SUPABASE_URL:-}"
key="${SUPABASE_ANON_KEY:-}"

if [ -z "$url" ] && [ -z "$key" ]; then
  echo "::notice title=Keep-alive not configured::Set the SUPABASE_URL variable and the SUPABASE_ANON_KEY secret (DEPLOY.md §5)."
  exit 0
fi
if [ -z "$url" ] || [ -z "$key" ]; then
  echo "::error title=Keep-alive misconfigured::Both SUPABASE_URL and SUPABASE_ANON_KEY are needed."
  exit 1
fi
url="${url%/}"
case "$url" in
  https://*) ;;
  http://*) if [ "${KEEP_ALIVE_ALLOW_HTTP:-}" != 1 ]; then
      echo "::error title=Keep-alive misconfigured::SUPABASE_URL must be https://<ref>.supabase.co"
      exit 1
    fi ;;
  *) echo "::error title=Keep-alive misconfigured::SUPABASE_URL must be https://<ref>.supabase.co"
    exit 1 ;;
esac

jitter="${JITTER_MAX_S:-0}"
if [ "$jitter" -gt 0 ]; then sleep $((RANDOM % jitter)); fi

headers=(-H "apikey: ${key}" -H 'Content-Type: application/json')
# A legacy anon key is a JWT and also goes in Authorization; a publishable key does not.
case "$key" in eyJ*) headers+=(-H "Authorization: Bearer ${key}") ;; esac

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
# curl retries timeouts, refused connections, 408, 429, 500, 502, 503 and 504; never 540/402.
status="$(curl -sS -o "$body_file" -w '%{http_code}' \
  --max-time "${KEEP_ALIVE_MAX_TIME:-30}" --retry 2 --retry-delay "${KEEP_ALIVE_RETRY_DELAY:-15}" \
  --retry-connrefused -X POST "${url}/rest/v1/rpc/keep_alive" "${headers[@]}" -d '{}')" || true
status="${status:-000}"
body="$(head -c 400 "$body_file" | tr -d '\r\n')"
echo "HTTP ${status}: ${body}"

runbook='docs/runbooks/free-plan-quotas.md'
case "$status" in
  200)
    if printf '%s' "$body" | grep -Eq '"read_only"[[:space:]]*:[[:space:]]*true'; then
      echo "::error title=Supabase database is READ-ONLY::The database is over the Free plan's 500 MB (Supabase makes it read-only). See ${runbook}."
      exit 1
    fi
    if printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
      echo "::notice title=Supabase is awake::keep_alive answered ${body}"
      exit 0
    fi
    echo "::error title=Unexpected answer::HTTP 200 but not keep_alive's answer: is SUPABASE_URL the project's API URL?"
    exit 1 ;;
  540)
    echo "::error title=Supabase project is PAUSED::Restore it (Supabase dashboard → the project → Restore project), then run this workflow again. See ${runbook}."
    exit 1 ;;
  402)
    echo "::error title=Supabase project is RESTRICTED::Supabase restricts a Free project that exceeded its quotas (HTTP 402). Check the organization's Usage page. See ${runbook}."
    exit 1 ;;
  401|403)
    echo "::error title=Key refused::HTTP ${status}: SUPABASE_ANON_KEY is not this project's anon or publishable key."
    exit 1 ;;
  404)
    echo "::error title=keep_alive not found::HTTP 404: a wrong SUPABASE_URL, or the migrations are not applied (supabase db push)."
    exit 1 ;;
  000)
    echo "::error title=No answer::Supabase did not answer (3 tries). Check https://status.supabase.com and the project's dashboard."
    exit 1 ;;
  *)
    echo "::error title=Keep-alive failed::HTTP ${status}. See ${runbook}."
    exit 1 ;;
esac
