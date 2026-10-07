# Deploy do Copiloto Financeiro no Docker Swarm

## Arquitetura

- O backend roda sem porta publicada e participa da overlay externa definida
  por `COPILOTO_NETWORK_NAME` (por padrao, `proxy`).
- O n8n acessa internamente `http://copiloto_backend:3333`.
- O Traefik publica somente HTTPS e encaminha para a porta interna `3333`.
- Todas as rotas, exceto `/health` e `/health/live`, exigem
  `Authorization: Bearer <token-do-n8n>`.
- `DATABASE_URL`, `OPENAI_API_KEY` e `N8N_API_TOKEN` entram como Docker
  secrets. O arquivo `deploy.env` guarda somente valores não secretos.

Copie `deploy.env.example` para `deploy.env` e ajuste o host publico, a rede
overlay, o nome do servico PostgreSQL, o hostname interno do PostgreSQL e o
database do Copiloto para o seu ambiente. Os valores do arquivo de exemplo sao
apenas placeholders seguros para publicacao.

## Imagens

No diretório do projeto:

```sh
docker build --target runtime -t copiloto-financeiro:latest .
docker build --target migrations -t copiloto-financeiro-migrations:latest .
```

## Secrets

Crie secrets sem escrever o valor na linha de comando. Os nomes são
versionados porque o Swarm não altera um secret existente.

```sh
read -rsp 'DATABASE_URL: ' secret_value
printf '%s' "$secret_value" | docker secret create copiloto_database_url_v1 -
unset secret_value

read -rsp 'OPENAI_API_KEY: ' secret_value
printf '%s' "$secret_value" | docker secret create copiloto_openai_api_key_v1 -
unset secret_value

read -rsp 'N8N_API_TOKEN: ' secret_value
printf '%s' "$secret_value" | docker secret create copiloto_n8n_api_token_v1 -
unset secret_value
```

O token colocado no último secret deve ser salvo como credencial Header Auth
do n8n. O header é `Authorization` e o valor é `Bearer <token>`.

Para backup, crie `copiloto_backup_database_url_v1` com uma URI PostgreSQL
aceita pelo `pg_dump`. Ela pode apontar para o mesmo banco, mas não deve conter
o parâmetro Prisma `?schema=public`.

## Ordem de publicação

1. Criar e validar um backup com `backup-postgres.sh`.
2. Construir as duas imagens.
3. Executar `run-migrations.sh` com a imagem de migrations.
4. Preencher `deploy.env` a partir de `deploy.env.example`.
5. Exportar suas variáveis e publicar a stack:

```sh
set -a
. ./deploy/deploy.env
set +a
docker stack deploy --compose-file deploy/stack.yml copiloto
```

6. Conferir `docker service ps copiloto_backend` e os logs do serviço.
7. Testar primeiro `/health/live`, depois uma requisição autenticada pela rede
   interna do Swarm e, por fim, o endereço HTTPS do Traefik.

## Backup recorrente

`backup-postgres.sh` cria um dump customizado, valida o arquivo com
`pg_restore --list` e mantém 14 dias por padrão. Depois do primeiro backup e de
um teste real de restauração, ele pode ser agendado diariamente no host.
