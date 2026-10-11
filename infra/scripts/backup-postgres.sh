#!/usr/bin/env bash
# =============================================================================
# PostgreSQL backup → local disk → Cloudflare R2 (separate backup bucket).
#     backup-postgres.sh [label]          e.g. nightly | pre-deploy-1a2b3c4d
#
# Reads /srv/trendz/shared/backup.env:
#   DATABASE_URL                 same database as the API (query string is ignored)
#   BACKUP_DIR=/srv/trendz/backups
#   LOCAL_RETENTION_DAYS=7
#   BACKUP_BUCKET=trendz-backups  R2 bucket WITHOUT public access; add a lifecycle
#                                rule there (e.g. delete after 35 days)
#   BACKUP_R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
#   BACKUP_R2_ACCESS_KEY_ID / BACKUP_R2_SECRET_ACCESS_KEY
#                                an R2 API token limited to the backup bucket
# Leave BACKUP_BUCKET empty to keep local copies only.
# =============================================================================
set -Eeuo pipefail

CONFIG="${BACKUP_CONFIG:-/srv/trendz/shared/backup.env}"
# shellcheck disable=SC1090
[[ -f "$CONFIG" ]] && set -a && source "$CONFIG" && set +a

LABEL="${1:-manual}"
: "${DATABASE_URL:?DATABASE_URL is not set (see $CONFIG)}"
BACKUP_DIR="${BACKUP_DIR:-/srv/trendz/backups}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-7}"

# libpq rejects Prisma-only parameters such as ?schema=public.
DB_URL="${DATABASE_URL%%\?*}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/trendz-$STAMP-$LABEL.dump"

umask 077
mkdir -p "$BACKUP_DIR"

echo "dumping database → $FILE"
pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$DB_URL" --file="$FILE"

# A dump that cannot be listed cannot be restored.
pg_restore --list "$FILE" >/dev/null
sha256sum "$FILE" > "$FILE.sha256"
echo "verified ($(du -h "$FILE" | cut -f1))"

if [[ -n "${BACKUP_BUCKET:-}" ]]; then
  : "${BACKUP_R2_ENDPOINT:?BACKUP_R2_ENDPOINT is required when BACKUP_BUCKET is set}"
  export AWS_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:?}" AWS_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:?}" AWS_DEFAULT_REGION=auto
  KEY="postgres/$(date -u +%Y/%m)/$(basename "$FILE")"
  aws s3 cp --only-show-errors --endpoint-url "$BACKUP_R2_ENDPOINT" "$FILE" "s3://$BACKUP_BUCKET/$KEY"
  aws s3 cp --only-show-errors --endpoint-url "$BACKUP_R2_ENDPOINT" "$FILE.sha256" "s3://$BACKUP_BUCKET/$KEY.sha256"
  echo "uploaded s3://$BACKUP_BUCKET/$KEY"
fi

find "$BACKUP_DIR" -name 'trendz-*.dump*' -type f -mtime +"$LOCAL_RETENTION_DAYS" -delete
echo "done"
