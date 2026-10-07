import type {
  CreateTransactionData,
  CreateTransactionInput,
  UpdateTransactionInput,
} from "../core/schemas/types.js";

import { DomainError } from "../core/errors.js";
import * as accountsRepository from "../data/accountsReposity.js";
import * as categoriesRepository from "../data/categoriesRepository.js";
import * as transactionsRepository from "../data/transactionsRepository.js";

function calculateReferenceMonth(
  transactionDate: Date,
): Date {
  return new Date(
    Date.UTC(
      transactionDate.getUTCFullYear(),
      transactionDate.getUTCMonth(),
      1,
    ),
  );
}
// ensure = garantir
async function ensureAccountIsAvailable(
  tenantId: string,
  accountId: string,
): Promise<void> {
  const account =
    await accountsRepository.findActiveAccountForTenant(
      tenantId,
      accountId,
    );

  if (!account) {
    throw new DomainError(
      "ACCOUNT_UNAVAILABLE",
      "Conta não encontrada ou indisponível.",
    );
  }
}

async function ensureCategoryIsAvailable(
  tenantId: string,
  categoryId: string | null | undefined,
): Promise<void> {
  if (categoryId === null || categoryId === undefined) {
    return;
  }

  const category = await categoriesRepository.findById(
    tenantId,
    categoryId,
  );

  if (!category) {
    throw new DomainError(
      "CATEGORY_UNAVAILABLE",
      "Categoria não encontrada ou indisponível.",
    );
  }
}

export async function getTransactions(
  tenantId: string,
) {
  return transactionsRepository.findTransactions(
    tenantId,
  );
}

export async function getTransactionById(
  tenantId: string,
  transactionId: string,
) {
  const transaction =
    await transactionsRepository.findTransactionById(
      tenantId,
      transactionId,
    );

  if (!transaction) {
    throw new DomainError(
      "TRANSACTION_NOT_FOUND",
      "Transação não encontrada.",
    );
  }

  return transaction;
}

export async function createTransaction(
  tenantId: string,
  input: CreateTransactionInput,
) {
  await ensureAccountIsAvailable(
    tenantId,
    input.accountId,
  );

  await ensureCategoryIsAvailable(
    tenantId,
    input.primaryCategoryId,
  );

  const data: CreateTransactionData = {
    ...input,
    referenceMonth: calculateReferenceMonth(
      input.transactionDate,
    ),
  };

  return transactionsRepository.createTransaction(
    tenantId,
    data,
  );
}

export async function updateTransaction(
  tenantId: string,
  transactionId: string,
  input: UpdateTransactionInput,
) {
  if (input.accountId !== undefined) {
    await ensureAccountIsAvailable(
      tenantId,
      input.accountId,
    );
  }

  await ensureCategoryIsAvailable(
    tenantId,
    input.primaryCategoryId,
  );

  const transaction =
    await transactionsRepository.updateTransaction(
      tenantId,
      input,
      transactionId,
    );

  if (!transaction) {
    throw new DomainError(
      "TRANSACTION_NOT_FOUND",
      "Transação não encontrada.",
    );
  }

  return transaction;
}

export async function deleteTransaction(
  tenantId: string,
  transactionId: string,
): Promise<void> {
  const deleted =
    await transactionsRepository.ignoreTransaction(
      tenantId,
      transactionId,
    );

  if (!deleted) {
    throw new DomainError(
      "TRANSACTION_NOT_FOUND",
      "Transação não encontrada.",
    );
  }
}
