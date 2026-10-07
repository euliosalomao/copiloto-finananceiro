import type { TransactionForReport } from "./schemas/types.js";
import {
  calculateExpenses,
  calculateIncome,
  calculateNetResult,
  groupExpensesByCategory,
  topExpenses,
} from "./calculation.js";

export type MonthlyReport = {
  summary: {
    income: number;
    expenses: number;
    balance: number;
    transactionCount: number;
  };
  expensesByCategory: { category: string; amount: number }[];
  topExpenses: {
    id: string;
    description: string;
    amount: number;
    date: string;
    category: string;
  }[];
};

// Este objeto é dado de API, não texto para exibição. O front decide como formatar BRL.
export function generateMonthlyReport(items: TransactionForReport[]): MonthlyReport {
  const expensesByCategory = Object.entries(groupExpensesByCategory(items))
    .map(([category, amount]) => ({ category, amount: amount ?? 0 }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category, "pt-BR"));

  return {
    summary: {
      income: calculateIncome(items),
      expenses: calculateExpenses(items),
      balance: calculateNetResult(items),
      transactionCount: items.length,
    },
    expensesByCategory,
    topExpenses: topExpenses(items).map((transaction) => ({
      id: transaction.id,
      description: transaction.description,
      amount: transaction.amount,
      date: transaction.date.toISOString().slice(0, 10),
      category: transaction.category,
    })),
  };
}
