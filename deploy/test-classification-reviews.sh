#!/bin/sh
set -eu

TEST_IMAGE="${COPILOTO_TEST_IMAGE:?Defina COPILOTO_TEST_IMAGE}"
NETWORK_NAME="${COPILOTO_NETWORK_NAME:-proxy}"
DATABASE_SECRET_NAME="${COPILOTO_DATABASE_SECRET_NAME:-copiloto_database_url_v1}"
SERVICE_NAME="copiloto-review-test-$(date -u +%Y%m%d%H%M%S)"

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
  --secret "source=$DATABASE_SECRET_NAME,target=database_url" \
  --env DATABASE_URL_FILE=/run/secrets/database_url \
  --env CLASSIFICATION_REVIEW_DB_TESTS=1 \
  --restart-condition none \
  "$TEST_IMAGE" \
  node --import tsx --test \
    src/tests/classificationReviewDatabase.test.ts >/dev/null

attempt=0
while [ "$attempt" -lt 90 ]; do
  state="$(docker service ps "$SERVICE_NAME" --format '{{.CurrentState}}' | head -n 1)"
  case "$state" in
    Complete*)
      docker service logs "$SERVICE_NAME"
      echo "Teste transacional da fila de reviews concluído."
      exit 0
      ;;
    Failed*|Rejected*)
      docker service ps --no-trunc "$SERVICE_NAME"
      docker service logs "$SERVICE_NAME" || true
      echo "Teste transacional da fila de reviews falhou." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

docker service ps --no-trunc "$SERVICE_NAME"
echo "Tempo limite aguardando teste da fila de reviews." >&2
exit 1
