import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { DomainError } from "../core/errors.js";
import type { CsvRow, ImportCandidate } from "../core/csvImport.js";
import type { ImportRepository } from "../services/importService.js";
import { prisma } from "../lib/prisma.js";

async function findCandidates(
  db: Prisma.TransactionClient,
  tenantId: string,
  accountId: string,
  rows: CsvRow[],
): Promise<ImportCandidate[]> {
  const valid = rows.filter((row) => row.values !== null && row.importKey !== null);
  if (!valid.length) return [];
  const dates = valid.map((row) => row.values!.transactionDate).sort();
  const stored = await db.transactions.findMany({
    where: {
      tenant_id: tenantId,
      account_id: accountId,
      // Inclui ignored: reimportar não deve ressuscitar uma transação excluída.
      OR: [
        { transaction_date: { gte: new Date(dates[0]!), lte: new Date(dates[dates.length - 1]!) } },
        { provider: "CSV", external_transaction_id: { in: valid.map((row) => row.importKey!) } },
      ],
    },
    select: {
      id: true, provider: true, external_transaction_id: true, ignored: true,
      transaction_date: true, description: true, amount: true, direction: true, operation_type: true,
    },
  });
  return stored.map((row) => ({
    id: row.id,
    importKey: row.provider === "CSV" ? row.external_transaction_id : null,
    ignored: row.ignored,
    transactionDate: row.transaction_date.toISOString().slice(0, 10),
    description: row.description,
    amount: row.amount.toFixed(2),
    direction: row.direction,
    operationType: row.operation_type,
  }));
}

export const importRepository: ImportRepository = {
  async inspect(tenantId, accountId, rows) {
    const account = await prisma.accounts.findFirst({
      where: { id: accountId, tenant_id: tenantId, is_active: true },
      select: { id: true },
    });
    if (!account) throw new DomainError("ACCOUNT_UNAVAILABLE", "Conta não encontrada ou indisponível.");
    return findCandidates(prisma, tenantId, accountId, rows);
  },

  async withAccountLock(tenantId, accountId, work) {
    return prisma.$transaction(async (tx) => {
      // Lock da conta: duas importações CSV simultâneas esperam uma pela outra.
      // A consulta é parametrizada; nenhum UUID é concatenado ao SQL.
      const accounts = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM accounts
        WHERE id = ${accountId}::uuid AND tenant_id = ${tenantId}::uuid AND is_active = true
        FOR UPDATE
      `);
      if (!accounts.length) throw new DomainError("ACCOUNT_UNAVAILABLE", "Conta não encontrada ou indisponível.");

      return work({
        findCandidates: (rows) => findCandidates(tx, tenantId, accountId, rows),
        async save(rows) {
          const transactions = rows.map((row) => {
            if (!row.values || !row.importKey) throw new Error("Linha inválida chegou à persistência do CSV.");
            const values = row.values;
            return {
              id: randomUUID(), tenant_id: tenantId, account_id: accountId,
              provider: "CSV", external_transaction_id: row.importKey,
              transaction_date: new Date(`${values.transactionDate}T00:00:00.000Z`),
              reference_month: new Date(`${values.transactionDate.slice(0, 7)}-01T00:00:00.000Z`),
              description: values.description, amount: values.amount,
              direction: values.direction, operation_type: values.operationType,
              notes: values.notes || null, status: "POSTED", ignored: false, is_manual: false,
            };
          });
          // Sem skipDuplicates: pular parte do lote violaria o contrato tudo-ou-nada.
          await tx.transactions.createMany({ data: transactions });
          await tx.transaction_classifications.createMany({
            data: transactions.map((row) => ({
              tenant_id: tenantId, transaction_id: row.id,
              status: "PENDING_REVIEW", classified_by: "DEFAULT",
              reasoning: "CSV_IMPORT_PENDING_REVIEW",
            })),
          });
          return transactions.map((row) => row.id);
        },
      });
    }, { maxWait: 10_000, timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },
};
