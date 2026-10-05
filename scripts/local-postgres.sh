#!/usr/bin/env bash
# Local, ephemeral PostgreSQL for ALKAO tests. Never points at staging or production.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${ALKAO_PG_DIR:-$ROOT/.local-postgres}"
PORT="${ALKAO_PG_PORT:-54329}"
BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"

# PostgreSQL refuses to run as root (e.g. in CI or cloud containers): use the postgres user.
as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

case "${1:-}" in
  start)
    if [ ! -d "$DATA_DIR/data" ]; then
      mkdir -p "$DATA_DIR"
      if [ "$(id -u)" = "0" ]; then chown postgres "$DATA_DIR"; fi
      as_pg "$BIN/initdb" -D "$DATA_DIR/data" -U postgres --auth=trust --encoding=UTF8 >/dev/null
    fi
    if ! as_pg "$BIN/pg_ctl" -D "$DATA_DIR/data" status >/dev/null 2>&1; then
      as_pg "$BIN/pg_ctl" -D "$DATA_DIR/data" -l "$DATA_DIR/postgres.log" \
        -o "-p $PORT -k $DATA_DIR -c listen_addresses=127.0.0.1 -c max_connections=200" -w start >/dev/null
    fi
    echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/postgres"
    ;;
  stop)
    as_pg "$BIN/pg_ctl" -D "$DATA_DIR/data" -m fast stop >/dev/null 2>&1 || true
    ;;
  destroy)
    as_pg "$BIN/pg_ctl" -D "$DATA_DIR/data" -m fast stop >/dev/null 2>&1 || true
    rm -rf "$DATA_DIR"
    ;;
  *)
    echo "usage: $0 start|stop|destroy" >&2
    exit 2
    ;;
esac
