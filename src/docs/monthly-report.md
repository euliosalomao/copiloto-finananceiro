# Relatório mensal — V1

## GET /report

Parâmetros obrigatórios: `month` (1 a 12) e `year` (2000 a 2100).

`accountId` é opcional. Sem ele, o relatório consolida todas as contas do
tenant. Com ele, traz só a conta selecionada. Assim a tela pode começar pela
visão geral e depois filtrar sem precisar de duas rotas diferentes.

Exemplo: `GET /report?month=9&year=2026`

```json
{
  "period": { "month": 9, "year": 2026 },
  "accountId": null,
  "report": {
    "summary": {
      "income": 3500,
      "expenses": 175.9,
      "balance": 3324.1,
      "transactionCount": 12
    },
    "expensesByCategory": [
      { "category": "Alimentação", "amount": 125.9 },
      { "category": "Transporte", "amount": 50 }
    ],
    "topExpenses": [
      {
        "id": "UUID",
        "description": "Mercado",
        "amount": 125.9,
        "date": "2026-09-02",
        "category": "Alimentação"
      }
    ]
  }
}
```

O relatório considera somente transações `POSTED` e não ignoradas. Entradas
são `INCOME`; saídas são `EXPENSE`. `TRANSFER`, `INVESTMENT` e `ADJUSTMENT`
não entram no saldo desta V1. Uma transferência interna antiga cadastrada como
despesa com categoria `TRANSFERENCIA_INTERNA` também é excluída.

Transações sem categoria aparecem como `SEM_CATEGORIA` em `expensesByCategory`.
Isso é esperado após uma importação CSV enquanto a revisão ainda não foi feita.

Valores no JSON são números, para o frontend calcular gráficos e formatar reais.
Internamente, os totais são somados em centavos para evitar a imprecisão de ponto
flutuante do JavaScript. Um mês vazio retorna a mesma estrutura, com totais `0`
e listas vazias.
