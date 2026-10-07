#!/bin/sh
set -eu
exec 2>&1

POSTGRES_SERVICE_NAME="${COPILOTO_POSTGRES_SERVICE_NAME:-postgres}"

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
initial_database="$(printf '%s\n' "$postgres_env" | sed -n 's/^POSTGRES_DB=//p' | head -n 1)"
database_user="${database_user:-postgres}"
initial_database="${initial_database:-$database_user}"

databases="$(docker exec "$container_id" psql \
  --username "$database_user" \
  --dbname "$initial_database" \
  --no-psqlrc --tuples-only --no-align \
  --command "
    SELECT datname
    FROM pg_database
    WHERE datallowconn
      AND NOT datistemplate
    ORDER BY datname;
  ")"

target_database=""
for candidate_database in $databases; do
  objects="$(docker exec "$container_id" psql \
    --username "$database_user" \
    --dbname "$candidate_database" \
    --no-psqlrc --tuples-only --no-align \
    --command "
      SELECT concat_ws('|',
        COALESCE(to_regclass('public.accounts')::text, 'missing'),
        COALESCE(to_regclass('public.transactions')::text, 'missing')
      );
    ")"
  if [ "$objects" = "accounts|transactions" ]; then
    target_database="$candidate_database"
    break
  fi
done

if [ -z "$target_database" ]; then
  echo "Nenhum banco contém public.accounts e public.transactions." >&2
  echo "Bancos verificados: $(printf '%s' "$databases" | tr '\n' ' ')" >&2
  exit 1
fi

schema_state="$(docker exec "$container_id" psql \
  --username "$database_user" \
  --dbname "$target_database" \
  --no-psqlrc --tuples-only --no-align \
  --command "
    SELECT 'database=' || current_database();
    SELECT 'prisma_migrations=' || COALESCE(
      to_regclass('public._prisma_migrations')::text,
      'missing'
    );
    SELECT 'import_batches=' || COALESCE(
      to_regclass('public.import_batches')::text,
      'missing'
    );
    SELECT 'accounts_tenant_constraint=' || COALESCE((
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.accounts')
        AND conname = 'accounts_id_tenant_unique_idx'
    ), 'missing');
    SELECT 'classified_by_check=' || COALESCE((
      SELECT pg_get_constraintdef(oid)
      FROM pg_constraint
      WHERE conrelid = to_regclass('public.transaction_classifications')
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%classified_by%'
      LIMIT 1
    ), 'missing');
  ")"

printf '%s\n' "$schema_state"

if printf '%s\n' "$schema_state" | grep -q '^prisma_migrations=_prisma_migrations$'; then
  docker exec "$container_id" psql \
    --username "$database_user" \
    --dbname "$target_database" \
    --no-psqlrc --tuples-only --no-align \
    --command "
      SELECT 'migration=' || migration_name || ':' ||
        CASE WHEN finished_at IS NULL THEN 'unfinished' ELSE 'finished' END
      FROM public._prisma_migrations
      WHERE migration_name IN (
        '20260920000000_add_import_batches',
        '20260924000000_allow_ai_classifications'
      )
      ORDER BY migration_name;
    "
fi
