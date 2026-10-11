#!/usr/bin/env bash
# =============================================================================
# Restores a backup into a NEW database. It never overwrites an existing one.
#     restore-postgres.sh <file.dump | s3-key> [target_db]
#
#   restore-postgres.sh /srv/trendz/backups/trendz-20261009T023000Z-nightly.dump
#   restore-postgres.sh postgres/2026/10/trendz-20261009T023000Z-nightly.dump trendz_restore
#
# After checking the restored data, switching the app to it is a deliberate,
# manual step (see DEPLOYMENT.md → "Restore"): stop the app, rename databases,
# start the app.
# =============================================================================
set -Eeuo pipefail

CONFIG="${BACKUP_CONFIG:-/srv/trendz/shared/backup.env}"
# shellcheck disable=SC1090
[[ -f "$CONFIG" ]] && set -a && source "$CONFIG" && set +a

SRC="${1:?usage: restore-postgres.sh <file.dump | s3-key> [target_db]}"
TARGET="${2:-trendz_restore_$(date -u +%Y%m%d%H%M)}"
: "${DATABASE_URL:?DATABASE_URL is not set (see $CONFIG)}"
DB_URL="${DATABASE_URL%%\?*}"
# Connection to the maintenance database on the same server.
ADMIN_URL="${DB_URL%/*}/postgres"
TARGET_URL="${DB_URL%/*}/$TARGET"

[[ "$TARGET" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "invalid database name: $TARGET" >&2; exit 1; }

FILE="$SRC"
if [[ ! -f "$SRC" ]]; then
  : "${BACKUP_BUCKET:?not a local file and BACKUP_BUCKET is not set}"
  export AWS_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:?}" AWS_DEFAULT_REGION=auto
  FILE="$(mktemp -d)/$(basename "$SRC")"
  aws s3 cp --only-show-errors --endpoint-url "$BACKUP_R2_ENDPOINT" "s3://$BACKUP_BUCKET/$SRC" "$FILE"
  aws s3 cp --only-show-errors --endpoint-url "$BACKUP_R2_ENDPOINT" "s3://$BACKUP_BUCKET/$SRC.sha256" "$FILE.sha256" || true
fi

if [[ -f "$FILE.sha256" ]]; then
  (cd "$(dirname "$FILE")" && sha256sum -c <(sed "s#  .*/#  #" "$FILE.sha256"))
fi

EXISTS="$(psql "$ADMIN_URL" -Atc "SELECT 1 FROM pg_database WHERE datname = '$TARGET'")"
[[ -z "$EXISTS" ]] || { echo "database $TARGET already exists — refusing to overwrite it" >&2; exit 1; }

echo "creating $TARGET and restoring $(basename "$FILE")"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET\""
pg_restore --no-owner --no-privileges --exit-on-error --dbname="$TARGET_URL" "$FILE"

echo
echo "restored into $TARGET. Quick check:"
psql "$TARGET_URL" -Atc "SELECT 'orders: ' || count(*) FROM orders UNION ALL SELECT 'products: ' || count(*) FROM products UNION ALL SELECT 'last migration: ' || max(migration_name) FROM _prisma_migrations"
