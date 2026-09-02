#!/usr/bin/env bash
# deploy/provision-db.sh — create the Postgres role + database for Universe.
#
# Run on the database host as root (uses `sudo -u postgres psql`), or from
# anywhere with ADMIN_URL pointing at a superuser connection:
#
#   sudo deploy/provision-db.sh
#   ADMIN_URL=postgresql://postgres:secret@db.internal:5432/postgres deploy/provision-db.sh
#
# Environment:
#   DB_NAME       database name                      (default: universe)
#   DB_USER       owner role (login)                 (default: universe)
#   DB_PASSWORD   password for DB_USER; generated when empty and the role is new
#   DB_HOST       host to put in the printed DATABASE_URL (default: localhost)
#   DB_PORT       port for the printed DATABASE_URL  (default: 5432)
#
# Idempotent: an existing role keeps its password unless DB_PASSWORD is given
# explicitly; an existing database is left alone. The last line on stdout is a
# ready-to-paste DATABASE_URL= line (password URL-encoded).
#
# The role is a plain owner (NOSUPERUSER). Migrations need only ownership: the
# pgcrypto and uuid-ossp extensions are "trusted" on PostgreSQL 13+, so the
# database owner can create them.
set -euo pipefail

DB_NAME="${DB_NAME:-universe}"
DB_USER="${DB_USER:-universe}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

log() { echo "[provision-db] $*" >&2; }

# SQL is fed on stdin (not -c) so psql interpolates the -v variables, which is
# what quotes the role/database names and the password safely.
if [ -n "${ADMIN_URL:-}" ]; then
  admin_psql() { psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qAt "$@"; }
elif [ "$(id -u)" = 0 ]; then
  admin_psql() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }
elif sudo -n -u postgres true 2>/dev/null; then
  admin_psql() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qAt "$@"; }
else
  log "run as root (sudo) or set ADMIN_URL to a superuser connection string"; exit 1
fi

urlencode() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9.~_-]) out+="$c" ;;
      *) out+=$(printf '%%%02X' "'$c") ;;
    esac
  done
  printf '%s' "$out"
}

role_exists=$(admin_psql -v u="$DB_USER" <<<"SELECT 1 FROM pg_roles WHERE rolname = :'u'" | grep -c 1 || true)
if [ "$role_exists" = 0 ]; then
  if [ -z "$DB_PASSWORD" ]; then
    DB_PASSWORD=$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-32)
    log "generated a password for role $DB_USER (shown once in the DATABASE_URL below)"
  fi
  admin_psql -v u="$DB_USER" -v pw="$DB_PASSWORD" \
    <<<"CREATE ROLE :\"u\" WITH LOGIN PASSWORD :'pw' NOSUPERUSER NOCREATEDB NOCREATEROLE"
  log "created role $DB_USER"
elif [ -n "$DB_PASSWORD" ]; then
  admin_psql -v u="$DB_USER" -v pw="$DB_PASSWORD" <<<"ALTER ROLE :\"u\" WITH LOGIN PASSWORD :'pw'"
  log "role $DB_USER exists — password updated from DB_PASSWORD"
else
  log "role $DB_USER exists — password left unchanged (set DB_PASSWORD to rotate it)"
fi

db_exists=$(admin_psql -v d="$DB_NAME" <<<"SELECT 1 FROM pg_database WHERE datname = :'d'" | grep -c 1 || true)
if [ "$db_exists" = 0 ]; then
  admin_psql -v d="$DB_NAME" -v u="$DB_USER" \
    <<<"CREATE DATABASE :\"d\" OWNER :\"u\" ENCODING 'UTF8' TEMPLATE template0"
  log "created database $DB_NAME owned by $DB_USER"
else
  admin_psql -v d="$DB_NAME" -v u="$DB_USER" <<<"ALTER DATABASE :\"d\" OWNER TO :\"u\"" >/dev/null
  log "database $DB_NAME exists — owner ensured"
fi

if [ -n "$DB_PASSWORD" ]; then
  echo "DATABASE_URL=postgresql://${DB_USER}:$(urlencode "$DB_PASSWORD")@${DB_HOST}:${DB_PORT}/${DB_NAME}"
else
  echo "DATABASE_URL=postgresql://${DB_USER}:<existing password>@${DB_HOST}:${DB_PORT}/${DB_NAME}"
fi
