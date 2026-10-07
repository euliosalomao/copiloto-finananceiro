import { randomUUID } from "node:crypto";
import { Prisma } from "../generated/prisma/client.js";
import { DomainError } from "../core/errors.js";
import type {
  NormalizedStatementTransaction,
  ParsedBankStatement,
} from "../integrations/bankStatements/types.js";
import { prisma } from "../lib/prisma.js";

export type FingerprintedStatementTransaction = {
  transaction: NormalizedStatementTransaction;
  identityKey: string;
};

export type PersistStatementInput = {
  tenantId: string;
  accountId: string;
  statement: ParsedBankStatement;
  transactions: readonly FingerprintedStatementTransaction[];
};

export type PersistStatementResult = {
  transactionIds: string[];
  duplicateCount: number;
};

function operationType(transaction: NormalizedStatementTransaction) {
  return transaction.operationTypeHint ??
    (transaction.direction === "INFLOW" ? "INCOME" : "EXPENSE");
}

export const statementImportRepository = {
  async assertAccountAvailable(tenantId: string, accountId: string) {
    const account = await prisma.accounts.findFirst({
      where: { id: accountId, tenant_id: tenantId, is_active: true },
      select: { id: true },
    });

    if (!account) {
      throw new DomainError(
        "ACCOUNT_UNAVAILABLE",
        "Conta não encontrada ou indisponível.",
      );
    }
  },

  persist(input: PersistStatementInput): Promise<PersistStatementResult> {
    return prisma.$transaction(async (tx) => {
      // Serializa importações da mesma conta. Arquivos sobrepostos podem chegar
      // juntos, mas apenas um decide primeiro quais fingerprints são novas.
      const accounts = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id FROM accounts
        WHERE id = ${input.accountId}::uuid
          AND tenant_id = ${input.tenantId}::uuid
          AND is_active = true
        FOR UPDATE
      `);

      if (!accounts.length) {
        throw new DomainError(
          "ACCOUNT_UNAVAILABLE",
          "Conta não encontrada ou indisponível.",
        );
      }

      const identityKeys = input.transactions.map((item) => item.identityKey);
      const existing = identityKeys.length
        ? await tx.transactions.findMany({
            where: {
              tenant_id: input.tenantId,
              provider: input.statement.provider,
              external_transaction_id: { in: identityKeys },
            },
            select: { external_transaction_id: true },
          })
        : [];
      const existingKeys = new Set(
        existing.flatMap((item) =>
          item.external_transaction_id ? [item.external_transaction_id] : []),
      );
      const fresh = input.transactions.filter(
        (item) => !existingKeys.has(item.identityKey),
      );
      const rows = fresh.map(({ transaction, identityKey }) => {
        const id = randomUUID();
        const inferredOperationType = transaction.operationTypeHint === null;

        return {
          id,
          tenant_id: input.tenantId,
          account_id: input.accountId,
          provider: input.statement.provider,
          external_transaction_id: identityKey,
          transaction_date: new Date(`${transaction.transactionDate}T00:00:00.000Z`),
          reference_month: new Date(`${transaction.transactionDate.slice(0, 7)}-01T00:00:00.000Z`),
          description: transaction.description,
          amount: transaction.amount,
          direction: transaction.direction,
          operation_type: operationType(transaction),
          status: "POSTED",
          ignored: false,
          is_manual: false,
          raw_json: {
            ...transaction.raw,
            __statement: {
              format: input.statement.format,
              rowNumber: transaction.rowNumber,
              sourceType: transaction.sourceType,
              balanceAfter: transaction.balanceAfter,
              bankExternalId: transaction.externalId,
              inferredOperationType,
            },
          },
        };
      });

      if (rows.length) {
        // O lock da conta torna o conjunto estável. Sem skipDuplicates, qualquer
        // inconsistência inesperada desfaz o lote em vez de escondê-la.
        await tx.transactions.createMany({ data: rows });
      }

      return {
        transactionIds: rows.map((row) => row.id),
        duplicateCount: input.transactions.length - rows.length,
      };
    }, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  },
};

export type StatementImportRepository = typeof statementImportRepository;
