#!/bin/sh
set -eu

BACKUP_DIR="/var/backups/copiloto"
BACKUP_SECRET_NAME="${COPILOTO_BACKUP_SECRET_NAME:-copiloto_backup_database_url_v1}"
NETWORK_NAME="${COPILOTO_NETWORK_NAME:-proxy}"
RETENTION_DAYS="${COPILOTO_BACKUP_RETENTION_DAYS:-14}"
SERVICE_NAME="copiloto-backup-$(date -u +%Y%m%d%H%M%S)"

case "$RETENTION_DAYS" in
  ''|*[!0-9]*)
    echo "COPILOTO_BACKUP_RETENTION_DAYS deve ser um número inteiro." >&2
    exit 1
    ;;
esac

install -d -m 0700 "$BACKUP_DIR"

cleanup() {
  docker service rm "$SERVICE_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker service create \
  --detach \
  --name "$SERVICE_NAME" \
  --mode replicated-job \
  --constraint node.role==manager \
  --network "$NETWORK_NAME" \
  --secret "source=$BACKUP_SECRET_NAME,target=database_url" \
  --mount "type=bind,source=$BACKUP_DIR,target=/backups" \
  --restart-condition none \
  postgres:14 \
  sh -ec 'umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="/backups/copiloto-${stamp}.dump"
pg_dump --format=custom --compress=9 --no-owner --no-acl \
  --file="$target" "$(cat /run/secrets/database_url)"
pg_restore --list "$target" >/dev/null
echo "Backup criado e validado: $target"' >/dev/null

attempt=0
while [ "$attempt" -lt 300 ]; do
  state="$(docker service ps "$SERVICE_NAME" --format '{{.CurrentState}}' | head -n 1)"
  case "$state" in
    Complete*)
      docker service logs "$SERVICE_NAME"
      find "$BACKUP_DIR" -maxdepth 1 -type f \
        -name 'copiloto-*.dump' -mtime "+$RETENTION_DAYS" -delete
      echo "Backup concluído; retenção configurada em $RETENTION_DAYS dias."
      exit 0
      ;;
    Failed*|Rejected*)
      docker service ps --no-trunc "$SERVICE_NAME"
      docker service logs "$SERVICE_NAME" || true
      echo "Backup falhou." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

docker service ps --no-trunc "$SERVICE_NAME"
echo "Tempo limite aguardando o backup." >&2
exit 1
