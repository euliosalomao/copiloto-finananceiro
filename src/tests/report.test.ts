import assert from "node:assert/strict";
import test from "node:test";
import { calculateExpenses, calculateIncome, calculateNetResult, groupExpensesByCategory, topExpenses } from "../core/calculation.js";
import { generateMonthlyReport } from "../core/report.js";
import type { TransactionForReport } from "../core/schemas/types.js";

const transaction = (input: Partial<TransactionForReport>): TransactionForReport => ({
  id: input.id ?? "c48c61e9-7e4d-4f43-b074-535c02dba66d",
  description: input.description ?? "Teste",
  amount: input.amount ?? 0,
  date: input.date ?? new Date("2026-09-01T00:00:00.000Z"),
  operationType: input.operationType ?? "EXPENSE",
  category: input.category ?? "SEM_CATEGORIA",
  accountContext: input.accountContext ?? "PF",
});

test("relatório mensal devolve dados estruturados e não texto", () => {
  const items = [
    transaction({ id: "89a38c8e-b2ce-480b-8b59-f2df4aac47c5", description: "Salário", amount: 1000, operationType: "INCOME" }),
    transaction({ id: "8a8bc7fc-3d50-42d2-a8df-52578f1a9cb7", description: "Mercado", amount: 100.2, category: "Alimentação" }),
    transaction({ id: "6bd574e2-5c0a-4d33-8d96-dfe6f3ee6c74", description: "Almoço", amount: 0.1, category: "Alimentação" }),
    transaction({ id: "b3cadb6b-7b56-4f09-a7c3-4f30dad05b25", description: "Uber", amount: 50, category: "Transporte" }),
    transaction({ id: "462fadd7-da12-44e2-b476-3384f269044b", description: "PIX entre contas", amount: 300, category: "TRANSFERENCIA_INTERNA" }),
    transaction({ id: "d572f768-58cf-4736-9b07-c1ffd9e30b31", description: "Transferência", amount: 300, operationType: "TRANSFER" }),
  ];

  assert.equal(calculateIncome(items), 1000);
  assert.equal(calculateExpenses(items), 150.3);
  assert.equal(calculateNetResult(items), 849.7);
  assert.deepEqual(groupExpensesByCategory(items), { "Alimentação": 100.3, "Transporte": 50 });
  assert.deepEqual(topExpenses(items).map((item) => item.description), ["Mercado", "Uber", "Almoço"]);
  assert.deepEqual(generateMonthlyReport(items), {
    summary: { income: 1000, expenses: 150.3, balance: 849.7, transactionCount: 6 },
    expensesByCategory: [{ category: "Alimentação", amount: 100.3 }, { category: "Transporte", amount: 50 }],
    topExpenses: [
      { id: "8a8bc7fc-3d50-42d2-a8df-52578f1a9cb7", description: "Mercado", amount: 100.2, date: "2026-09-01", category: "Alimentação" },
      { id: "b3cadb6b-7b56-4f09-a7c3-4f30dad05b25", description: "Uber", amount: 50, date: "2026-09-01", category: "Transporte" },
      { id: "6bd574e2-5c0a-4d33-8d96-dfe6f3ee6c74", description: "Almoço", amount: 0.1, date: "2026-09-01", category: "Alimentação" },
    ],
  });
});

test("mês vazio possui a mesma estrutura, com listas vazias", () => {
  assert.deepEqual(generateMonthlyReport([]), {
    summary: { income: 0, expenses: 0, balance: 0, transactionCount: 0 },
    expensesByCategory: [],
    topExpenses: [],
  });
});
