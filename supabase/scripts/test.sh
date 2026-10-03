#!/usr/bin/env bash
# Run the database test suite against a throwaway vanilla Postgres cluster.
#
#   bash supabase/scripts/test.sh
#
# Steps: install pgTAP/pg_prove if missing → initdb a temp cluster → start it on
# a unix socket only → apply the Supabase shim → apply every migration in
# filename order → apply seed.sql (if present) → run supabase/tests/*.test.sql
# with pg_prove. The cluster is always stopped and its directory removed, even
# on failure. Exit code 0 only if every test passes.
#
# Environment overrides:
#   PG_BIN      Postgres server binaries (default: /usr/lib/postgresql/16/bin,
#               falls back to `pg_config --bindir`)
#   PG_PORT     Port number used for the socket name (default: 54329; no TCP
#               listener is opened, so it cannot clash with other servers)
#   PGTEST_TMPDIR  Parent of the temp directory (default: /tmp as root,
#               otherwise $TMPDIR or /tmp)
#   KEEP_TMP=1  Keep the temp directory (for debugging; the server is still stopped)
#   VERBOSE=1   Print every TAP line (pg_prove --verbose)
#   NO_PG_PROVE=1  Skip pg_prove and use the plain-psql runner

set -euo pipefail
export LC_COLLATE=C   # glob expansion order = byte order of file names

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUPABASE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SHIM_DIR="$SCRIPT_DIR/shim"
MIGRATIONS_DIR="$SUPABASE_DIR/migrations"
TESTS_DIR="$SUPABASE_DIR/tests"
SEED_FILE="$SUPABASE_DIR/seed.sql"

PG_PORT="${PG_PORT:-54329}"
DB_NAME=postgres
DB_SUPERUSER=postgres

log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ─── Postgres binaries ────────────────────────────────────────────────────
if [[ -z "${PG_BIN:-}" ]]; then
  if [[ -x /usr/lib/postgresql/16/bin/initdb ]]; then
    PG_BIN=/usr/lib/postgresql/16/bin
  elif command -v pg_config >/dev/null 2>&1; then
    PG_BIN="$(pg_config --bindir)"
  else
    die "cannot find Postgres server binaries; set PG_BIN"
  fi
fi
[[ -x "$PG_BIN/initdb" && -x "$PG_BIN/pg_ctl" ]] || die "initdb/pg_ctl not found in $PG_BIN"
PG_MAJOR="$("$PG_BIN/initdb" --version | sed -E 's/^[^0-9]*([0-9]+).*/\1/')"   # "initdb (PostgreSQL) 16.x" → 16
command -v psql >/dev/null 2>&1 || die "psql not found on PATH"

# ─── pgTAP + pg_prove (idempotent) ────────────────────────────────────────
# pgTAP is required. pg_prove is preferred but optional: without it the tests
# run through plain psql (see the end of this script).
SHAREDIR="$("$PG_BIN/pg_config" --sharedir 2>/dev/null || echo "/usr/share/postgresql/$PG_MAJOR")"
have_pgtap() { [[ -f "$SHAREDIR/extension/pgtap.control" ]]; }
have_pg_prove() { [[ "${NO_PG_PROVE:-0}" != 1 ]] && command -v pg_prove >/dev/null 2>&1; }

apt_install() {   # best effort; returns non-zero on failure
  command -v apt-get >/dev/null 2>&1 || return 1
  local sudo=""
  if [[ "$(id -u)" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || return 1
    sudo="sudo"
  fi
  log "installing $* via apt"
  $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null && return 0
  log "apt-get install failed; refreshing package lists and retrying"
  $sudo apt-get update -qq >/dev/null || return 1
  $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "$@" >/dev/null
}

if ! have_pgtap; then
  apt_install "postgresql-$PG_MAJOR-pgtap" || true
  have_pgtap || die "pgTAP is not installed in $SHAREDIR and could not be installed (apt: postgresql-$PG_MAJOR-pgtap)"
fi
if [[ "${NO_PG_PROVE:-0}" != 1 ]] && ! have_pg_prove; then
  apt_install libtap-parser-sourcehandler-pgtap-perl \
    || log "pg_prove unavailable; falling back to psql"
fi

# ─── Who runs the server ──────────────────────────────────────────────────
# initdb/postgres refuse to run as root. As root, run them as the `postgres`
# system user (created if absent); otherwise run them as the current user.
as_pg() { "$@"; }
if [[ "$(id -u)" -eq 0 ]]; then
  PG_OS_USER=postgres
  if ! id "$PG_OS_USER" >/dev/null 2>&1; then
    log "creating system user $PG_OS_USER"
    useradd --system --no-create-home --shell /usr/sbin/nologin "$PG_OS_USER"
  fi
  # cd into the work dir: the server user may not be able to read the
  # caller's cwd (e.g. /root), which makes pg_ctl fail.
  as_pg() { (cd "$WORK_DIR" && runuser -u "$PG_OS_USER" -- "$@"); }
fi

# ─── Throwaway cluster ────────────────────────────────────────────────────
# As root, the server runs as another user that must be able to traverse the
# parent directory, so default to /tmp rather than a possibly private $TMPDIR.
if [[ "$(id -u)" -eq 0 ]]; then
  TMP_BASE="${PGTEST_TMPDIR:-/tmp}"
else
  TMP_BASE="${PGTEST_TMPDIR:-${TMPDIR:-/tmp}}"
fi
WORK_DIR="$(mktemp -d "$TMP_BASE/build-roulette-pgtest.XXXXXX")"
DATA_DIR="$WORK_DIR/data"
SOCK_DIR="$WORK_DIR/sock"
SERVER_LOG="$WORK_DIR/server.log"
SERVER_STARTED=0

cleanup() {
  local status=$?
  if (( SERVER_STARTED )); then
    as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m fast -w -t 30 stop >/dev/null 2>&1 \
      || as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 \
      || true
  fi
  if [[ "${KEEP_TMP:-0}" == 1 ]]; then
    log "keeping $WORK_DIR"
  else
    rm -rf "$WORK_DIR"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

mkdir -p "$SOCK_DIR"
if [[ "$(id -u)" -eq 0 ]]; then
  chown -R "$PG_OS_USER" "$WORK_DIR"
fi
chmod 700 "$WORK_DIR"

log "initdb ($PG_BIN, Postgres $PG_MAJOR) in $WORK_DIR"
as_pg "$PG_BIN/initdb" -D "$DATA_DIR" -U "$DB_SUPERUSER" --auth=trust \
  --encoding=UTF8 --no-locale --no-sync >"$WORK_DIR/initdb.log" 2>&1 \
  || { cat "$WORK_DIR/initdb.log" >&2; die "initdb failed"; }

log "starting server (unix socket only, port $PG_PORT)"
SERVER_STARTED=1
as_pg "$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$SERVER_LOG" -w -t 30 \
  -o "-c listen_addresses='' -c unix_socket_directories='$SOCK_DIR' -p $PG_PORT -c fsync=off -c full_page_writes=off -c synchronous_commit=off" \
  start >/dev/null \
  || { cat "$SERVER_LOG" >&2 || true; die "server failed to start"; }

export PGHOST="$SOCK_DIR" PGPORT="$PG_PORT" PGUSER="$DB_SUPERUSER" PGDATABASE="$DB_NAME"
unset PGPASSWORD PGSERVICE PGOPTIONS

run_sql_file() {
  psql -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$1" >/dev/null \
    || die "failed to apply $1"
}

# ─── Shim → migrations → seed ─────────────────────────────────────────────
shopt -s nullglob
shim_files=("$SHIM_DIR"/*.sql)
migration_files=("$MIGRATIONS_DIR"/*.sql)
test_files=("$TESTS_DIR"/*.test.sql)
shopt -u nullglob
(( ${#test_files[@]} > 0 )) || die "no test files in $TESTS_DIR"

for f in "${shim_files[@]}"; do
  log "shim       $(basename "$f")"
  run_sql_file "$f"
done
for f in "${migration_files[@]}"; do   # glob expansion is sorted → filename order
  log "migration  $(basename "$f")"
  run_sql_file "$f"
done
if [[ -f "$SEED_FILE" ]]; then
  log "seed       $(basename "$SEED_FILE")"
  run_sql_file "$SEED_FILE"
fi

# ─── Tests ────────────────────────────────────────────────────────────────
log "running ${#test_files[@]} test file(s)"
if have_pg_prove; then
  prove_opts=(--failures)
  if [[ "${VERBOSE:-0}" == 1 ]]; then prove_opts+=(--verbose); fi
  pg_prove "${prove_opts[@]}" "${test_files[@]}"
else
  # Fallback: plain psql. A TAP failure does not raise an SQL error, so a file
  # passes only if psql exits 0, it printed a plan "1..N", exactly N "ok"
  # lines and no "not ok" line.
  failed_files=0 total=0
  for f in "${test_files[@]}"; do
    file_ok=1
    out="$(psql -X -q -t -A -v ON_ERROR_STOP=1 -f "$f" 2>&1)" || file_ok=0
    if [[ "${VERBOSE:-0}" == 1 ]]; then printf '%s\n' "$out"; fi
    planned="$(sed -nE 's/^1\.\.([0-9]+)$/\1/p' <<<"$out" | head -n1)"
    passed="$(grep -cE '^ok [0-9]+' <<<"$out" || true)"
    if [[ -z "$planned" || "$passed" != "$planned" ]] || grep -qE '^not ok' <<<"$out"; then
      file_ok=0
    fi
    total=$(( total + passed ))
    if (( file_ok )); then
      printf '%s .. ok (%s tests)\n' "$f" "$passed"
    else
      failed_files=$(( failed_files + 1 ))
      printf '%s .. FAILED (planned %s, passed %s)\n' "$f" "${planned:-?}" "$passed"
      grep -E '^(not ok|#)|ERROR' <<<"$out" || true
    fi
  done
  printf 'Files=%d, passed tests=%d, failed files=%d\n' "${#test_files[@]}" "$total" "$failed_files"
  (( failed_files == 0 )) || die "tests failed"
  echo "Result: PASS"
fi
