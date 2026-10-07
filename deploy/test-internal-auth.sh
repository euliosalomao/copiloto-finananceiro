#!/bin/sh
set -eu

IMAGE="${COPILOTO_IMAGE:-copiloto-financeiro:20260928-2}"
NETWORK_NAME="${COPILOTO_NETWORK_NAME:-proxy}"
TOKEN_SECRET="${COPILOTO_N8N_SECRET_NAME:-copiloto_n8n_api_token_v1}"
SERVICE_NAME="copiloto-auth-test-$(date -u +%Y%m%d%H%M%S)"

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
  --secret "source=$TOKEN_SECRET,target=n8n_api_token" \
  --env N8N_API_TOKEN_FILE=/run/secrets/n8n_api_token \
  --restart-condition none \
  "$IMAGE" \
  node --input-type=module --eval '
    const response = await fetch("http://copiloto_backend:3333/accounts", {
      headers: { authorization: `Bearer ${process.env.N8N_API_TOKEN}` },
    });
    const body = await response.json();
    console.log(JSON.stringify({
      status: response.status,
      accountCount: Array.isArray(body.accounts) ? body.accounts.length : null,
      error: body.error ?? null,
    }));
    if (!response.ok) process.exit(1);
  ' >/dev/null

attempt=0
while [ "$attempt" -lt 60 ]; do
  state="$(docker service ps "$SERVICE_NAME" --format '{{.CurrentState}}' | head -n 1)"
  case "$state" in
    Complete*)
      docker service logs "$SERVICE_NAME"
      echo "Teste interno autenticado concluído."
      exit 0
      ;;
    Failed*|Rejected*)
      docker service ps --no-trunc "$SERVICE_NAME"
      docker service logs "$SERVICE_NAME" || true
      echo "Teste interno autenticado falhou." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

docker service ps --no-trunc "$SERVICE_NAME"
echo "Tempo limite aguardando teste interno." >&2
exit 1
