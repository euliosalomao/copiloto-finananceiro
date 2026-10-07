# Descoberta do CSV de conta corrente do Inter

Fonte analisada: extrato real exportado pelo usuário em 11/09/2026. Nenhum
número de conta, saldo ou texto de contraparte foi copiado para o repositório.

## Estrutura observada

- Arquivo UTF-8 sem BOM, com 15.251 bytes e 225 linhas físicas.
- Cinco linhas antes do cabeçalho da tabela: título, conta, período, saldo e
  uma linha vazia.
- Separador `;` e valores monetários no formato brasileiro.
- Cabeçalho com cinco colunas: `Data Lançamento`, `Histórico`, `Descrição`,
  `Valor` e `Saldo`.
- 218 movimentos entre 04/01/2026 e 01/09/2026.
- Registros ordenados do mais novo para o mais antigo.
- O saldo do cabeçalho coincide com o saldo da primeira transação.
- Todas as 217 transições entre saldos reconciliam exatamente com o valor da
  transação mais nova.

## Tipos encontrados

| Histórico | Linhas | Sinal observado |
| --- | ---: | --- |
| Pix enviado | 109 | negativo |
| Compra no débito | 52 | negativo |
| Pix recebido | 51 | positivo |
| Pagamento efetuado | 6 | negativo |

## Casos que o parser precisa aceitar

- `Pix enviado` aparece com espaço ao final e precisa ser normalizado.
- Três movimentos possuem descrição vazia; `Histórico` deve servir como
  descrição de fallback sem inventar contraparte.
- Existem até seis movimentos na mesma data.
- Existe um par de linhas igual em data, histórico, descrição e valor. Portanto
  esse conjunto de campos não pode ser tratado como identificador único.
- O CSV não apresentou identificador externo de transação nesta amostra.
- O saldo por linha pode validar a ordem e a integridade do arquivo, mas não
  deve participar da classificação financeira.

## Limite da descoberta

Esta amostra cobre conta corrente. Ela não prova que o CSV de cartão do Inter
usa o mesmo cabeçalho ou as mesmas convenções. Esse formato deve ganhar uma
fixture e um parser separado se entrar no escopo.

## Comportamento implementado

- O parser preserva a ordem do arquivo e converte datas para `AAAA-MM-DD`.
- Valores são tratados em centavos inteiros, sem ponto flutuante, e expostos
  como decimal positivo mais a direção `INFLOW` ou `OUTFLOW`.
- A linha original permanece disponível em `raw`.
- Descrição vazia usa o histórico como fallback e gera um aviso rastreável.
- `Compra no débito` recebe a dica `EXPENSE`. PIX e pagamento efetuado ficam
  sem dica porque o CSV não prova se representam despesa ou transferência.
- Divergências entre os saldos são devolvidas como warnings auditáveis, com a
  linha e os valores esperado/encontrado. Elas não bloqueiam a importação porque
  o saldo é informação auxiliar do extrato e não participa da identidade da
  transação.
- O parser continua rejeitando ordem cronológica inválida, linha fora do
  período, estrutura malformada e valores inválidos.
- Linhas iguais continuam distintas. A decisão de idempotência entre arquivos
  pertence ao serviço de importação, não ao parser.
