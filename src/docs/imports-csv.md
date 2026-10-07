# Importação CSV — backend V1

Esta etapa importa um arquivo para **uma conta existente**. O preview não grava nada;
a confirmação grava o lote inteiro e suas pendências de classificação na mesma
transação do PostgreSQL. Se houver erro, nenhum registro do lote permanece salvo.

Não foi necessário alterar o schema, executar migrations ou editar o `.env`.
O tenant continua vindo de `getTenantId()`, como nas demais rotas.

## Formato do arquivo

Como ainda não escolhemos um extrato real de banco, esta versão usa um formato
padronizado. Ela **não importa automaticamente qualquer layout bancário**.

```csv
transactionDate,description,amount,direction,operationType,externalId,notes
2026-09-01,Salário,3500.00,INFLOW,INCOME,banco-001,Setembro
2026-09-02,Mercado,125.90,OUTFLOW,EXPENSE,banco-002,Compra da semana
```

- Obrigatórias: `transactionDate`, `description`, `amount`, `direction`, `operationType`.
- Opcionais: `externalId`, `notes`. A ordem das colunas pode mudar.
- Cabeçalhos devem ter esses nomes exatos, sem repetição ou colunas extras.
- UTF-8, com ou sem BOM; separador vírgula ou ponto e vírgula.
- Data real em `YYYY-MM-DD`. Nada de adivinhar se `03/04` é março ou abril.
- Valor não negativo, sem separador de milhar, até 12 dígitos inteiros e 2 casas decimais.
  A direção define se entra ou sai dinheiro. Zero é aceito, como no cadastro manual.
- `direction`: `INFLOW` ou `OUTFLOW`.
- `operationType`: `INCOME`, `EXPENSE`, `TRANSFER`, `INVESTMENT` ou `ADJUSTMENT`.
  `INCOME` exige `INFLOW`; `EXPENSE` exige `OUTFLOW`.
- Descrição: 1–255 caracteres. `externalId`: até 200. Observação: até 2000.
- Até 2 MiB, 1000 transações e 64 KiB por registro CSV.
- Para usar decimal brasileiro: `2026-09-02;Mercado;125,90;OUTFLOW;EXPENSE`
  com o cabeçalho também separado por `;`. Se o separador for vírgula, o valor
  decimal com vírgula precisa estar entre aspas: `"125,90"`.
- Aspas permitem separadores dentro de campos. Uma aspa literal é escapada com
  outra aspa: `"Loja ""Centro"""`. Linhas vazias são ignoradas.

Cada arquivo pertence à conta selecionada; valores são interpretados na moeda
dessa conta. Não há conversão de moedas nem detecção automática do tipo de operação.

## Rotas

As duas recebem **multipart/form-data**, não JSON.

| Campo | Preview | Confirmação |
| --- | --- | --- |
| `file` | Um arquivo `.csv` | O mesmo arquivo |
| `accountId` | UUID de uma conta ativa do tenant | A mesma conta |
| `previewToken` | Não precisa | Token retornado pelo preview |
| `allowPossibleDuplicates` | Opcional: texto `true` ou `false` | Opcional: texto `true` ou `false` |

### POST /imports/csv/preview

Retorna `200`, inclusive quando há linhas inválidas. Exemplo de parte da resposta:

```json
{
  "accountId": "UUID_DA_CONTA",
  "previewToken": "HASH_DE_64_CARACTERES",
  "delimiter": ",",
  "headers": ["transactionDate", "description", "amount", "direction", "operationType"],
  "canImport": true,
  "summary": {
    "totalRows": 2,
    "validRows": 2,
    "invalidRows": 0,
    "duplicateRows": 0,
    "possibleDuplicateRows": 0
  },
  "rows": []
}
```

`rows` está abreviado acima. Cada item real contém:

- `rowNumber`: posição da transação, começando em 1, sem contar o cabeçalho.
- `line`: linha física final do registro no arquivo; campos com quebra de linha
  podem ocupar mais de uma linha física.
- `raw`: células originais após leitura do CSV, na ordem de `headers`.
  Isso permite mostrar inclusive os dados inválidos na tabela do front.
- `values`: campos validados/normalizados; `null` quando inválido.
  O valor monetário normalizado é texto, por exemplo `"125.90"`.
- `errors`: lista com `field` e `message` para indicar o que corrigir.
- `status`: `VALID`, `INVALID`, `DUPLICATE` ou `POSSIBLE_DUPLICATE`.
- `duplicates`: motivo e, quando aplicável, ID do registro existente ou posição
  da outra linha do arquivo. `ignored: true` indica exclusão lógica no banco.
- `importKey`: identidade técnica da linha; o frontend não deve produzi-la.

Os contadores de status são exclusivos: uma linha com alerta não entra também
em `validRows`. `canImport` considera a opção `allowPossibleDuplicates` enviada.

### POST /imports/csv

Retorna `201` após a transação do banco terminar:

```json
{
  "importedCount": 2,
  "pendingReviewCount": 2,
  "transactionIds": ["UUID_1", "UUID_2"],
  "previewToken": "HASH_DE_64_CARACTERES"
}
```

As transações entram com `provider: CSV`, `status: POSTED`, `is_manual: false`
e `ignored: false`. O mês de referência vem da data da transação.
Cada uma ganha uma classificação `PENDING_REVIEW` sem categoria. Nesta etapa
não chamamos LLM nem executamos automaticamente o classificador de comerciantes.

Depois, as rotas existentes continuam sendo usadas:

- `GET /classifications/pending`: listar as pendências.
- `GET /categories`: opções para revisar a categoria.
- `POST /transactions/:transactionId/classification/confirm`: confirmar.
- `POST /transactions/:transactionId/classify`: executar o classificador existente,
  se desejado, como uma ação separada da importação.
- `GET /report?month=9&year=2026`: consultar o relatório; a importação não reformula
  suas regras atuais.

### Erros esperados

| HTTP | Situação |
| --- | --- |
| 400 | Cabeçalho/arquivo malformado, campo inválido, conta indisponível ou token ausente |
| 409 | Arquivo/conta mudou desde o preview, duplicata certa ou alerta não confirmado |
| 413 | Arquivo, quantidade de linhas ou multipart excede os limites aplicáveis |
| 415 | Conteúdo não enviado como multipart |
| 422 | Há linhas com dados inválidos na confirmação |
| 500 | Falha inesperada no servidor/banco; não há sucesso parcial do lote |

Registro CSV individual acima de 64 KiB é tratado como CSV malformado (`400`).
Nos erros `CSV_INVALID_ROWS` e `CSV_DUPLICATES`, a resposta inclui um `preview`
atualizado para o front mostrar a situação. Nada é gravado nesses casos.

## Duplicatas e confirmação

1. Com `externalId`: a identidade é o ID estável fornecido no arquivo, dentro
   da conta. Repeti-lo no mesmo arquivo ou reimportá-lo é uma duplicata certa.
   Não use IDs inventados que reiniciam a cada extrato, como números de linha.
2. Sem `externalId`: a identidade usa o hash dos bytes do arquivo + posição + conta.
   Reenviar o mesmo arquivo não duplica, mesmo se mudar só o nome do arquivo.
3. Mesmo dia, descrição normalizada, valor, direção e operação: é uma **possível**
   duplicata. Pode ser outra compra legítima! Exige confirmação explícita.
4. `allowPossibleDuplicates=true` libera somente alertas. Não libera erro de
   validação, ID repetido ou registro já importado. O lote nunca é salvo em parte.
5. Registros com exclusão lógica também entram na comparação. O mesmo registro
   não deve reaparecer silenciosamente porque o CSV foi reenviado.

Sem um ID estável do banco, não existe deduplicação perfeita entre arquivos
diferentes. Mudar a ordem, as quebras de linha ou o conteúdo muda o hash; nesse
caso, a comparação de conteúdo continua produzindo alertas quando há semelhança.
Se CSV e uma integração bancária futura se sobrepuserem, precisaremos reconciliar
as origens, e não simplesmente confiar que os IDs são iguais.

O `previewToken` vincula arquivo, conta e tenant. **Não é autenticação, assinatura
secreta ou reserva no banco.** O commit sempre refaz a validação e a consulta de
duplicatas, pois outra importação pode acontecer entre o preview e a confirmação.
Um lock na conta serializa os commits CSV da mesma conta. Outras rotas não usam
esse lock: ele não impede uma compra manual semelhante de ser criada ao mesmo tempo.
O índice único existente continua protegendo a identidade externa da importação.

Se a resposta se perder após o banco confirmar a importação, reenviar o arquivo
não grava de novo: retorna duplicata. Consulte as transações ou gere novo preview.

## Como será o frontend

Uma tela pequena resolve esta primeira versão:

1. Buscar `GET /accounts` e preencher um seletor de conta.
2. Selecionar um CSV e clicar em **Pré-visualizar**.
3. Enviar arquivo + conta ao preview e mostrar uma tabela com erros e alertas.
4. Havendo erros ou duplicatas certas, pedir correção do arquivo e novo preview.
5. Havendo apenas possíveis duplicatas, oferecer confirmação explícita dos alertas.
6. Ao confirmar, reenviar o mesmo arquivo, conta, token e opção de duplicatas.
7. Mostrar o resultado e atualizar transações, relatório e pendências.

Não é necessário framework para testar o backend: Postman/Insomnia também enviam
multipart. Este exemplo é código para o futuro frontend, não uma tela já criada:

```js
// apiBase = URL configurada do backend, ou "" se o front usa proxy de mesma origem.
async function enviarCsv(apiBase, caminho, arquivo, conta, token, permitirDuplicatas = false) {
  const form = new FormData();
  form.append("accountId", conta);
  form.append("file", arquivo);
  if (token) form.append("previewToken", token);
  form.append("allowPossibleDuplicates", String(permitirDuplicatas));

  // Não defina Content-Type à mão: o navegador adiciona o boundary do multipart.
  const response = await fetch(`${apiBase}${caminho}`, { method: "POST", body: form });
  const result = await response.json();
  if (!response.ok) {
    // A tela deve exibir result.message e, se existir, result.preview.
    throw Object.assign(new Error(result.message), { status: response.status, result });
  }
  return result;
}

// Clique em "Pré-visualizar":
const preview = await enviarCsv(apiBase, "/imports/csv/preview", arquivo, conta);

// Só no clique posterior em "Confirmar", após mostrar a tabela e tratar alertas:
const resultado = await enviarCsv(
  apiBase, "/imports/csv", arquivo, conta, preview.previewToken, usuarioConfirmouAlertas,
);
```

Guarde arquivo/conta/token juntos. Se o usuário trocar arquivo ou conta, descarte
o preview. Desabilite os botões durante o envio; ao corrigir o CSV, gere novo preview.
Não renderize descrição/observações como HTML: são texto não confiável do arquivo.

Quando fizermos o frontend, configuraremos proxy ou CORS para a origem dele.
A V1 ainda usa tenant fixo e não adiciona autenticação: **não exponha essas rotas
publicamente como se já estivessem protegidas por login**.

## O que observar como dev

```text
Rota HTTP → Import service → Parser/validação + Repository → PostgreSQL
```

- `http/routes/routes/importRoutes.ts`: recebe multipart, valida os campos do pedido
  e responde HTTP. Não contém SQL nem decide como reconhecer uma duplicata.
- `core/csvImport.ts`: lê o formato, valida dados e monta o preview sem acessar banco.
  Zod confere o conteúdo; csv-parse entende aspas/separadores. Não use `split(',')`.
- `services/importService.ts`: coordena preview e confirmação, decide quando o lote
  pode ser salvo. Recebe um repository como dependência para permitir testes isolados.
- `data/importRepository.ts`: consulta conta/duplicatas e executa os INSERTs com Prisma.
  O callback de `$transaction` recebe `tx`; todas as gravações usam esse mesmo `tx`.
  Se uma delas falha, o erro sai do callback e o banco desfaz o lote.
- Valores monetários passam como texto decimal até o banco: evitamos introduzir
  arredondamentos de `number` na importação. Isso não refatora os cálculos anteriores.
- O backend valida de novo mesmo que a tela diga que está tudo certo. A tela ajuda
  a pessoa; o servidor é responsável por proteger as regras e o isolamento do tenant.

Dependências adicionadas: `@fastify/multipart` para receber arquivos e `csv-parse`
para interpretar CSV corretamente. O `package.json` declara essas dependências;
o lockfile registra as versões resolvidas. Nenhuma dependência de frontend foi adicionada.

## Testes

Na raiz do projeto:

```powershell
npm run check
node --import tsx --test src/tests/csvImport.test.ts src/tests/importRoutes.test.ts
```

Os testes acima não acessam banco. Cobrem parsing, dados inválidos, limites,
duplicatas, preview sem gravação e respostas HTTP.

Para testar PostgreSQL, com a conexão/túnel funcionando:

```powershell
$env:CSV_IMPORT_DB_TESTS = '1'
node --import tsx --test src/tests/importDatabase.test.ts
Remove-Item Env:CSV_IMPORT_DB_TESTS
```

Essa variável só existe no processo do terminal; não exige editar `.env`.
A suíte cria tenants/contas próprios, testa rollback real, exclusão lógica,
reenvio e commits concorrentes, e remove apenas suas fixtures ao terminar.
Execute em banco de desenvolvimento. Se o processo for interrompido à força,
a limpeza pode não rodar; os fixtures têm nome `csv-integration-<UUID>`.

## Próxima chunk

A tela de importação descrita acima, acompanhada de um CSV real do seu banco
(com dados pessoais removidos) para decidir se precisamos de um adaptador de layout.
Classificação automática durante importação, mapeamento visual de colunas, Pluggy,
WhatsApp, n8n e relatórios mais completos ficam fora desta etapa.

CSV pode continuar como entrada manual ou alternativa mesmo quando o Pluggy for a
principal origem. A ideia é mudar a forma de receber dados sem reescrever as regras
financeiras do projeto.

Referências: [multipart no Fastify](https://github.com/fastify/fastify-multipart)
e [opções do csv-parse](https://csv.js.org/parse/options/).
