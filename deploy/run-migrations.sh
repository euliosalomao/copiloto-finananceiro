#!/bin/sh
set -eu

MIGRATION_IMAGE="${COPILOTO_MIGRATION_IMAGE:?Defina COPILOTO_MIGRATION_IMAGE}"
NETWORK_NAME="${COPILOTO_NETWORK_NAME:-proxy}"
DATABASE_SECRET_NAME="${COPILOTO_DATABASE_SECRET_NAME:-copiloto_database_url_v1}"
SERVICE_NAME="copiloto-migrate-$(date -u +%Y%m%d%H%M%S)"

cleanup() {
  docker service rm "$SERVICE_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker service create \
  --detach \
  --name "$SERVICE_NAME" \
  --constraint node.role==manager \
  --network "$NETWORK_NAME" \
  --secret "source=$DATABASE_SECRET_NAME,target=database_url" \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --restart-condition none \
  "$MIGRATION_IMAGE" >/dev/null

attempt=0
while [ "$attempt" -lt 150 ]; do
  state="$(docker service ps "$SERVICE_NAME" --format '{{.CurrentState}}' | head -n 1)"
  case "$state" in
    Complete*)
      docker service logs "$SERVICE_NAME"
      echo "Migrations concluídas."
      exit 0
      ;;
    Failed*|Rejected*)
      docker service ps --no-trunc "$SERVICE_NAME"
      docker service logs "$SERVICE_NAME" || true
      echo "Migrations falharam." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

docker service ps --no-trunc "$SERVICE_NAME"
echo "Tempo limite aguardando migrations." >&2
exit 1
