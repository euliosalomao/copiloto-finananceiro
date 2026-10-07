#!/bin/sh
set -eu

IMAGE="${COPILOTO_IMAGE:-copiloto-financeiro:20260928-2}"
NETWORK_NAME="${COPILOTO_NETWORK_NAME:-proxy}"
TOKEN_SECRET="${COPILOTO_N8N_SECRET_NAME:-copiloto_n8n_api_token_v1}"
SERVICE_NAME="copiloto-upload-test-$(date -u +%Y%m%d%H%M%S)"

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
    const form = new FormData();
    form.append("accountId", "00000000-0000-4000-8000-000000000000");
    form.append("format", "INTER_CSV");
    form.append("source", "N8N");
    form.append("sourceMessageId", `smoke-test-${Date.now()}`);
    form.append(
      "file",
      new Blob(["Data Lançamento;Histórico;Descrição;Valor;Saldo\n"], {
        type: "text/csv",
      }),
      "smoke-test.csv",
    );
    const response = await fetch(
      "http://copiloto_backend:3333/imports/statements",
      {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.N8N_API_TOKEN}` },
        body: form,
      },
    );
    const body = await response.json();
    console.log(JSON.stringify({
      status: response.status,
      error: body.error ?? null,
    }));
    if (response.status !== 400 || body.error !== "ACCOUNT_UNAVAILABLE") {
      process.exit(1);
    }
  ' >/dev/null

attempt=0
while [ "$attempt" -lt 60 ]; do
  state="$(docker service ps "$SERVICE_NAME" --format '{{.CurrentState}}' | head -n 1)"
  case "$state" in
    Complete*)
      docker service logs "$SERVICE_NAME"
      echo "Upload interno chegou à aplicação sem gravar lote ou transação."
      exit 0
      ;;
    Failed*|Rejected*)
      docker service ps --no-trunc "$SERVICE_NAME"
      docker service logs "$SERVICE_NAME" || true
      echo "Teste interno de upload falhou." >&2
      exit 1
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 2
done

docker service ps --no-trunc "$SERVICE_NAME"
echo "Tempo limite aguardando teste interno de upload." >&2
exit 1
