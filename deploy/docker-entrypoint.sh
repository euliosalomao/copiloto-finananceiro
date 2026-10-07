#!/bin/sh
set -eu

if [ -n "${DATABASE_URL_FILE:-}" ]; then
  DATABASE_URL="$(cat "$DATABASE_URL_FILE")"
  export DATABASE_URL
fi

if [ -n "${OPENAI_API_KEY_FILE:-}" ]; then
  OPENAI_API_KEY="$(cat "$OPENAI_API_KEY_FILE")"
  export OPENAI_API_KEY
fi

if [ -n "${N8N_API_TOKEN_FILE:-}" ]; then
  N8N_API_TOKEN="$(cat "$N8N_API_TOKEN_FILE")"
  export N8N_API_TOKEN
fi

exec "$@"
