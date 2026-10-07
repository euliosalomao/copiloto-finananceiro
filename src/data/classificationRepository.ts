import { prisma } from "../lib/prisma.js";
import type {
  UpsertPendingInput, 
  UpsertAiSuggestionInput,
  ApplyMerchantRuleInput,
  ConfirmClassificationRepositoryInput 
} from "../core/schemas/types.js";

const classificationSelect = {
  id: true,
  transaction_id: true,
  status: true,
  classified_by: true,
  category_id: true,
  confidence_score: true,
  reasoning: true,
  updated_at: true,
} as const;

export function findOutcomeByTransaction(
  tenantId: string,
  transactionId: string,
) {
  return prisma.transaction_classifications.findFirst({
    where: {
      tenant_id: tenantId,
      transaction_id: transactionId,
    },
    select: classificationSelect,
  });
}

export async function upsertPending(input: UpsertPendingInput) {
  return prisma.$transaction(async (tx) => {
    const transaction = await tx.transactions.updateMany({
      where: {
        id: input.transactionId,
        tenant_id: input.tenantId,
      },
      data: {
        // Se uma reclassificação deixar de encontrar regra, a categoria antiga
        // não pode continuar aparecendo nos relatórios.
        primary_category_id: null,
        updated_at: new Date(),
      },
    });
    if (transaction.count === 0) return null;

    return tx.transaction_classifications.upsert({
      where: {
        transaction_id: input.transactionId,
      },
      update: {
        status: "PENDING_REVIEW",
        classified_by: "DEFAULT",
        category_id: null,
        confidence_score: null,
        reasoning: input.reason,
        updated_at: new Date(),
      },
      create: {
        tenant_id: input.tenantId,
        transaction_id: input.transactionId,
        status: "PENDING_REVIEW",
        classified_by: "DEFAULT",
        category_id: null,
        confidence_score: null,
        reasoning: input.reason,
      },
      select: {
        id: true,
        transaction_id: true,
        status: true,
        classified_by: true,
        category_id: true,
        confidence_score: true,
        reasoning: true,
        updated_at: true,
      },
    });
  });
}

export async function upsertAiSuggestion(input: UpsertAiSuggestionInput) {
  return prisma.$transaction(async (tx) => {
    // A lista enviada ao modelo é apenas a primeira barreira. Esta consulta
    // impede persistir uma categoria removida, inativa ou de outro tenant.
    const category = await tx.categories.findFirst({
      where: {
        id: input.categoryId,
        tenant_id: input.tenantId,
        is_active: true,
      },
      select: { id: true },
    });
    if (!category) return null;

    const transaction = await tx.transactions.updateMany({
      where: {
        id: input.transactionId,
        tenant_id: input.tenantId,
      },
      data: {
        // Sugestão não é confirmação: relatórios continuam sem categoria.
        primary_category_id: null,
        updated_at: new Date(),
      },
    });
    if (transaction.count === 0) return null;

    return tx.transaction_classifications.upsert({
      where: { transaction_id: input.transactionId },
      update: {
        status: "PENDING_REVIEW",
        classified_by: "AI",
        category_id: input.categoryId,
        confidence_score: input.confidence,
        reasoning: input.reasoning,
        updated_at: new Date(),
      },
      create: {
        tenant_id: input.tenantId,
        transaction_id: input.transactionId,
        status: "PENDING_REVIEW",
        classified_by: "AI",
        category_id: input.categoryId,
        confidence_score: input.confidence,
        reasoning: input.reasoning,
      },
      select: classificationSelect,
    });
  });
}

export async function applyMerchantRule(input: ApplyMerchantRuleInput){
  return prisma.$transaction(async (tx) => {
    const transaction = await tx.transactions.updateMany({
      where: {
        id: input.transactionId,
        tenant_id: input.tenantId,
      },
      data: {
        primary_category_id: input.rule.categoryId,
        updated_at: new Date(),
      },
    });
    if (transaction.count === 0) return null;

    return tx.transaction_classifications.upsert({
      where: {
        transaction_id: input.transactionId,
      },
      update: {
        status: "CLASSIFIED",
        classified_by: "RULE",
        category_id: input.rule.categoryId,
        confidence_score: input.rule.confidenceScore,
        reasoning: null,
        updated_at: new Date(),
      },
      create: {
        tenant_id: input.tenantId,
        transaction_id: input.transactionId,
        status: "CLASSIFIED",
        classified_by: "RULE",
        category_id: input.rule.categoryId,
        confidence_score: input.rule.confidenceScore,
        reasoning: null,
      },
      select: {
        id: true,
        transaction_id: true,
        status: true,
        classified_by: true,
        category_id: true,
        confidence_score: true,
        reasoning: true,
        updated_at: true,
      },
    });
  });
};

export async function findPendingByTenant(tenantId: string){
  const transactions = await prisma.transaction_classifications.findMany({
    where: {
      tenant_id: tenantId,
      status: "PENDING_REVIEW",
    },
    select: {
      id: true,
      transaction_id: true,
      status: true,
      classified_by: true,
      category_id: true,
      confidence_score: true,
      reasoning: true,
      created_at: true,
      categories: {
        select: {
          id: true,
          name: true,
          category_type: true,
        },
      },
      transactions: {
        select: {
          description: true,
          amount: true,
          transaction_date: true,
          direction: true,
          operation_type: true,
          accounts: {
            select: {
              id: true,
              name: true,
              account_context: true,
            },
          },
        },
      },
    }
  });
  
  return transactions;
}

export function findPendingByTransaction(
  tenantId: string,
  transactionId: string,
) {
  return prisma.transaction_classifications.findFirst({
    where: {
      tenant_id: tenantId,
      transaction_id: transactionId,
      status: "PENDING_REVIEW",
    },

    select: {
      id: true,
      transaction_id: true,
      status: true,
      classified_by: true,
      category_id: true,
      confidence_score: true,
      reasoning: true,
      created_at: true,
      transactions: {
        select: {
          description: true,
          amount: true,
          transaction_date: true,
          direction: true,
          operation_type: true,
          accounts: {
            select: {
              id: true,
              name: true,
              account_context: true,
            },
          },
        },
      },
    },
  });
}


export async function confirm(
  input: ConfirmClassificationRepositoryInput,
) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.categories.findFirst({
      where: {
        id: input.categoryId,
        tenant_id: input.tenantId,
        is_active: true,
      },
      select: { id: true },
    });
    if (!category) return null;

    const pendingClassification =
      await tx.transaction_classifications.findFirst({
        where: {
          tenant_id: input.tenantId,
          transaction_id: input.transactionId,
          status: "PENDING_REVIEW",
        },

        select: {
          id: true,
        },
      });

    if (!pendingClassification) {
      return null;
    }

    const claimed = await tx.transaction_classifications.updateMany({
      where: {
        id: pendingClassification.id,
        status: "PENDING_REVIEW",
      },
      data: {
        status: "CLASSIFIED",
        category_id: input.categoryId,
        classified_by: "USER",
        confidence_score: null,
        reasoning: null,
        updated_at: new Date(),
      },
    });
    if (claimed.count === 0) return null;

    const confirmedClassification =
      await tx.transaction_classifications.findUniqueOrThrow({
        where: { id: pendingClassification.id },
        select: classificationSelect,
      });

    const transaction = await tx.transactions.updateMany({
      where: {
        id: input.transactionId,
        tenant_id: input.tenantId,
      },
      data: {
        primary_category_id: input.categoryId,
        updated_at: new Date(),
      },
    });
    if (transaction.count === 0) {
      throw new Error("Transação da classificação pendente não foi encontrada.");
    }

    const merchantRule = input.merchantRule
      ? await tx.merchant_rules.create({
        data: {
          category_id: input.categoryId,
          tenant_id: input.tenantId,
          pattern: input.merchantRule.pattern,
          match_type: input.merchantRule.matchType,
          account_context: input.merchantRule.accountContext,
          direction: input.merchantRule.direction,
          operation_type: input.merchantRule.operationType,
          active: true,
        },
        select: { id: true },
      })
      : null;

    if (input.reviewResolution) {
      const resolvedAt = new Date();
      const resolvedReview = await tx.classification_reviews.updateMany({
        where: {
          id: input.reviewResolution.reviewId,
          tenant_id: input.tenantId,
          classification_id: pendingClassification.id,
          status: "WAITING_REPLY",
        },
        data: {
          status: "RESOLVED",
          reply_message: input.reviewResolution.replyMessage,
          resolved_category_id: input.categoryId,
          resolved_at: resolvedAt,
          updated_at: resolvedAt,
        },
      });
      if (resolvedReview.count === 0) {
        throw new Error("A revisão da classificação não está aguardando resposta.");
      }
    }

    return {
      classification: confirmedClassification,
      merchantRuleId: merchantRule?.id ?? null,
    };
  });
}
