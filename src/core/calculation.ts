import type { TransactionForReport } from "./schemas/types.js";

function isExpense(item: TransactionForReport): boolean {
  // Compatibilidade com registros antigos que foram cadastrados como EXPENSE,
  // mas representam transferência interna.
  return item.operationType === "EXPENSE" && item.category !== "TRANSFERENCIA_INTERNA";
}

// Dinheiro não é somado como 0.1 + 0.2: internamente usamos centavos inteiros.
export function toCents(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

function sumAmounts(items: TransactionForReport[]): number {
  return fromCents(items.reduce((total, item) => total + toCents(item.amount), 0));
}

export function calculateIncome(items: TransactionForReport[]): number {
  return sumAmounts(items.filter((item) => item.operationType === "INCOME"));
}

export function calculateExpenses(items: TransactionForReport[]): number {
  return sumAmounts(items.filter(isExpense));
}

export function calculateNetResult(items: TransactionForReport[]): number {
  return fromCents(toCents(calculateIncome(items)) - toCents(calculateExpenses(items)));
}

export function filterTransactionsByMonth(
  month: number,
  year: number,
  items: TransactionForReport[],
): TransactionForReport[] {
  return items.filter((item) =>
    item.date.getUTCMonth() + 1 === month && item.date.getUTCFullYear() === year,
  );
}

export function groupExpensesByCategory(items: TransactionForReport[]): Record<string, number> {
  const totalsInCents = new Map<string, number>();
  for (const item of items) {
    if (!isExpense(item)) continue;
    const category = item.category || "SEM_CATEGORIA";
    totalsInCents.set(category, (totalsInCents.get(category) ?? 0) + toCents(item.amount));
  }
  return Object.fromEntries([...totalsInCents].map(([category, cents]) => [category, fromCents(cents)]));
}

export function topExpenses(items: TransactionForReport[], limit = 3): TransactionForReport[] {
  return [...items]
    .filter(isExpense)
    .sort((a, b) => toCents(b.amount) - toCents(a.amount) || a.date.getTime() - b.date.getTime())
    .slice(0, limit);
}

// Útil para CLI ou logs. A resposta HTTP devolve números, para o front poder reutilizá-los.
export function formatCurrency(value: number): string {
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
