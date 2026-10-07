#!/bin/sh
set -eu

RUNTIME_SECRET="copiloto_database_url_v1"
BACKUP_SECRET="copiloto_backup_database_url_v1"
POSTGRES_SERVICE_NAME="${COPILOTO_POSTGRES_SERVICE_NAME:-postgres}"
POSTGRES_HOST="${COPILOTO_POSTGRES_HOST:-$POSTGRES_SERVICE_NAME}"

container_id="$(
  docker ps \
    --filter "label=com.docker.swarm.service.name=$POSTGRES_SERVICE_NAME" \
    --format '{{.ID}}' | head -n 1
)"

if [ -z "$container_id" ]; then
  echo "Container do serviço $POSTGRES_SERVICE_NAME não encontrado." >&2
  exit 1
fi

postgres_env="$(docker inspect "$container_id" --format '{{range .Config.Env}}{{println .}}{{end}}')"
database_user="$(printf '%s\n' "$postgres_env" | sed -n 's/^POSTGRES_USER=//p' | head -n 1)"
database_password="$(printf '%s\n' "$postgres_env" | sed -n 's/^POSTGRES_PASSWORD=//p' | head -n 1)"
initial_database="$(printf '%s\n' "$postgres_env" | sed -n 's/^POSTGRES_DB=//p' | head -n 1)"
database_user="${database_user:-postgres}"
initial_database="${initial_database:-$database_user}"
database_name="${COPILOTO_DATABASE_NAME:-copiloto}"

if [ -z "$database_password" ]; then
  echo "POSTGRES_PASSWORD não encontrado na configuração do serviço." >&2
  exit 1
fi

case "$database_name" in
  ''|*[!A-Za-z0-9_-]*)
    echo "Nome de database inválido." >&2
    exit 1
    ;;
esac

database_exists="$(docker exec "$container_id" psql \
  --username "$database_user" \
  --dbname "$initial_database" \
  --no-psqlrc --tuples-only --no-align \
  --command "SELECT 1 FROM pg_database WHERE datname = '$database_name';" \
  | tr -d '[:space:]')"
if [ "$database_exists" != "1" ]; then
  echo "Database $database_name não encontrado." >&2
  exit 1
fi

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read(), safe=""))'
}

encoded_user="$(printf '%s' "$database_user" | urlencode)"
encoded_password="$(printf '%s' "$database_password" | urlencode)"
encoded_database="$(printf '%s' "$database_name" | urlencode)"
base_url="postgresql://${encoded_user}:${encoded_password}@${POSTGRES_HOST}:5432/${encoded_database}"

if docker secret inspect "$RUNTIME_SECRET" >/dev/null 2>&1; then
  echo "Secret $RUNTIME_SECRET já existe; mantido sem alterações."
else
  printf '%s?schema=public' "$base_url" | docker secret create "$RUNTIME_SECRET" - >/dev/null
  echo "Secret $RUNTIME_SECRET criado."
fi

if docker secret inspect "$BACKUP_SECRET" >/dev/null 2>&1; then
  echo "Secret $BACKUP_SECRET já existe; mantido sem alterações."
else
  printf '%s' "$base_url" | docker secret create "$BACKUP_SECRET" - >/dev/null
  echo "Secret $BACKUP_SECRET criado."
fi

unset postgres_env database_password encoded_password base_url
