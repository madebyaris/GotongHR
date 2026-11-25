#!/bin/sh
set -eu
SAMPLE=/usr/local/share/postgresql/postgresql.conf.sample
MARKER="include = '/etc/postgresql/postgres.vps.conf'"
if [ -f "$SAMPLE" ] && ! grep -F "postgres.vps.conf" "$SAMPLE" >/dev/null 2>&1; then
  printf '\n%s\n' "$MARKER" >> "$SAMPLE"
fi
if [ -n "${PGDATA:-}" ] && [ -f "$PGDATA/postgresql.conf" ] && ! grep -F "postgres.vps.conf" "$PGDATA/postgresql.conf" >/dev/null 2>&1; then
  printf '\n%s\n' "$MARKER" >> "$PGDATA/postgresql.conf"
fi
exec docker-entrypoint.sh "$@"
