import { prisma } from "../lib/prisma.js";
import * as types from "../core/schemas/types.js";
 
export async function findTransactions(tenantId: string) {
  const transactions = await prisma.transactions.findMany({
    where: {
      tenant_id: tenantId,
      ignored: false,
      status: "POSTED",
    },
    select: {
      id: true,
      description: true,
      amount: true,
      operation_type: true,
      transaction_date: true,
      
      categories: {
        select: {
          name:true,
        },
      },

      accounts: {
        select: {
          account_context: true,
        },
      },
    },
  });


  return transactions.map((transaction) => ({
    id: transaction.id,
    description: transaction.description,
    amount: Number(transaction.amount),

    date: transaction.transaction_date,

    operationType:
      transaction.operation_type as types.TransactionOperationType,

    category:
      transaction.categories?.name ?? "SEM_CATEGORIA",

    accountContext:
      transaction.accounts.account_context as types.AccountContext,
  }));
}

export async function findTransactionsForReport(
  tenantId: string,
  input: { month: number; year: number; accountId?: string },
): Promise<types.TransactionForReport[]> {
  const monthStart = new Date(Date.UTC(input.year, input.month - 1, 1));
  const nextMonthStart = new Date(Date.UTC(input.year, input.month, 1));

  const transactions = await prisma.transactions.findMany({
    where: {
      tenant_id: tenantId,
      ...(input.accountId && { account_id: input.accountId }),
      ignored: false,
      status: "POSTED",
      transaction_date: { gte: monthStart, lt: nextMonthStart },
    },

    select: {
      id: true,
      description: true,
      amount: true,
      transaction_date: true,
      operation_type: true,

      categories: {
        select: {
          name: true,
        },
      },

      accounts: {
        select: {
          account_context: true,
        },
      },
    },
  });

  return transactions.map((transaction) => ({
    id: transaction.id,

    description: transaction.description,

    amount: Number(transaction.amount),

    date: transaction.transaction_date,

    operationType:
      transaction.operation_type as types.TransactionOperationType,

    category:
      transaction.categories?.name ?? "SEM_CATEGORIA",

    accountContext:
      transaction.accounts.account_context as types.AccountContext,
  }));
}

export async function findTransactionById(tenantId: string , transactionId: string){
  const transaction = await prisma.transactions.findFirst({
    where: {
      id: transactionId,
      tenant_id: tenantId,
      ignored: false,
    },
    select: {
      id: true,
      description: true,
      amount: true,
      transaction_date: true,
      reference_month: true,
      direction: true,
      operation_type: true,
      status: true,
      notes: true,

      accounts: {
        select: {
          id: true,
          name: true,
          account_context: true,
        },
      },

      categories: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!transaction) {
    return null;
  }
  
  return transaction;
}

export async function createTransaction(tenant_id:string, body:types.CreateTransactionData) {
  return prisma.transactions.create({
    data: {
      tenant_id: tenant_id,
      account_id: body.accountId,

      transaction_date: body.transactionDate,
      reference_month: body.referenceMonth,

      description: body.description,
      amount: body.amount,

      direction: body.direction,
      operation_type: body.operationType,
      project_id: body.projectId ?? null,
      primary_category_id:
        body.primaryCategoryId ?? null,
      notes: body.notes,
      provider: "MANUAL",
      is_manual: true
    }
  })
};


export async function updateTransaction(tenantId:string ,body:types.UpdateTransactionInput , transactionId:string){
  const existingTransaction = await prisma.transactions.findFirst({
    where: {
      id: transactionId,
      tenant_id: tenantId,
      ignored: false,
    },
    select: {
      id: true,
    },
  });
  if(!existingTransaction){
    return null;
  }
  return prisma.transactions.update({
    where: {
      id: transactionId,
    },
    data:{
      ...(body.accountId !== undefined && {
        account_id: body.accountId,
      }),

      ...(body.transactionDate !== undefined && {
        transaction_date: body.transactionDate,

        reference_month: new Date(
          Date.UTC(
            body.transactionDate.getUTCFullYear(),
            body.transactionDate.getUTCMonth(),
            1,
          ),
        ),
      }),

      ...(body.description !== undefined && {
        description: body.description,
      }),

      ...(body.amount !== undefined && {
        amount: body.amount,
      }),

      ...(body.direction !== undefined && {
        direction: body.direction,
      }),

      ...(body.operationType !== undefined && {
        operation_type: body.operationType,
      }),

      ...(body.primaryCategoryId !== undefined && {
        primary_category_id:
          body.primaryCategoryId,
      }),

      ...(body.notes !== undefined && {
        notes: body.notes,
      }),

      updated_at: new Date(), 
    }

  })
}

export async function ignoreTransaction(tenantId:string , transactionId:string): Promise<boolean>{
    const result = await prisma.transactions.updateMany({
      where: {
        id: transactionId,
        tenant_id: tenantId,
        ignored: false,
      },
      data: {
        ignored: true,
        updated_at: new Date(),
      },
    });

    return result.count > 0;
}
  
export async function findTransactionForClassification(
  tenantId: string,
  transactionId: string,
): Promise<types.TransactionForClassification | null> {
  const transaction =
    await prisma.transactions.findFirst({
      where: {
        id: transactionId,
        tenant_id: tenantId,
        ignored: false,
      },

      select: {
        id: true,
        description: true,
        amount: true,
        transaction_date: true,
        direction: true,
        operation_type: true,

        accounts: {
          select: {
            account_context: true,
          },
        },
      },
    });

  if (!transaction) {
    return null;
  }

  return {
    id: transaction.id,
    description: transaction.description,
    amount: transaction.amount.toFixed(2),
    transactionDate: transaction.transaction_date.toISOString().slice(0, 10),

    accountContext:
      transaction.accounts
        .account_context as types.AccountContext,

    direction:
      transaction.direction as types.TransactionDirection,

    operationType:
      transaction.operation_type as
        types.TransactionOperationType,
  };
}
