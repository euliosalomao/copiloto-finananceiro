import type {
  AiCategoryCandidate,
  AiCategoryClassifier,
} from "../core/aiClassification.js";
import { AiClassificationContractError } from "../core/aiClassification.js";
import type {
  ClassificationResult,
  MerchantRuleCandidate,
  TransactionForClassification,
} from "../core/schemas/types.js";
import * as type from "../core/schemas/types.js";
import * as transactionsRepository from "../data/transactionsRepository.js";
import * as merchantRulesRepository from "../data/merchantRulesRepository.js";
import { DomainError } from "../core/errors.js";
import * as classification from "../core/classification.js";
import * as classificationRepository from "../data/classificationRepository.js";
import * as categoriesRepository from "../data/categoriesRepository.js";
import { openAiCategoryClassifier } from "../integrations/ai/openAiCategoryClassifier.js";

type StoredClassification = {
  status: string;
  classifiedBy: string;
  categoryId: string | null;
  confidence: number | null;
  reasoning: string | null;
};

export type TransactionClassifierDependencies = {
  findTransaction(
    tenantId: string,
    transactionId: string,
  ): Promise<TransactionForClassification | null>;
  findExisting(
    tenantId: string,
    transactionId: string,
  ): Promise<StoredClassification | null>;
  findRules(input: {
    tenantId: string;
    accountContext: string;
    direction: string;
    operationType: string;
  }): Promise<MerchantRuleCandidate[]>;
  findCategories(tenantId: string): Promise<AiCategoryCandidate[]>;
  savePending(input: type.UpsertPendingInput): Promise<unknown>;
  saveAiSuggestion(input: type.UpsertAiSuggestionInput): Promise<unknown | null>;
  applyRule(input: type.ApplyMerchantRuleInput): Promise<unknown | null>;
  aiClassifier: AiCategoryClassifier;
};

function pendingResult(
  transactionId: string,
  reason:
    | "NO_MATCHING_MERCHANT_RULE"
    | "NO_VALID_CATEGORIES"
    | "AI_CLASSIFICATION_FAILED"
    | "AI_INVALID_SUGGESTION",
): ClassificationResult {
  return { status: "PENDING_REVIEW", transactionId, reason };
}

export function createTransactionClassifier(
  dependencies: TransactionClassifierDependencies,
) {
  return async function classifyTransaction(
    tenantId: string,
    transactionId: string,
  ): Promise<ClassificationResult> {
    const transaction = await dependencies.findTransaction(
      tenantId,
      transactionId,
    );
    if (!transaction) {
      throw new DomainError(
        "TRANSACTION_NOT_FOUND",
        "Transação não encontrada.",
      );
    }

    const existing = await dependencies.findExisting(tenantId, transactionId);
    if (existing?.status === "CLASSIFIED") {
      return {
        status: "ALREADY_PROCESSED",
        transactionId,
        classificationStatus: existing.status,
        classifiedBy: existing.classifiedBy,
        categoryId: existing.categoryId,
      };
    }
    if (
      existing?.status === "PENDING_REVIEW" &&
      existing.classifiedBy === "AI" &&
      existing.categoryId
    ) {
      return {
        status: "PENDING_REVIEW",
        transactionId,
        reason: "AI_SUGGESTION",
        suggestedCategoryId: existing.categoryId,
        classifiedBy: "AI",
        confidence: existing.confidence,
        reasoning: existing.reasoning,
      };
    }

    const rules = await dependencies.findRules({
      tenantId,
      accountContext: transaction.accountContext,
      direction: transaction.direction,
      operationType: transaction.operationType,
    });
    const matchedRule = rules.find((rule) =>
      classification.matchesMerchantRule(
        transaction.description,
        rule.pattern,
        rule.matchType,
      ),
    );
    if (matchedRule) {
      await dependencies.applyRule({
        tenantId,
        transactionId,
        rule: matchedRule,
      });
      return {
        status: "CLASSIFIED",
        transactionId,
        categoryId: matchedRule.categoryId,
        ruleId: matchedRule.id,
        classifiedBy: "RULE",
        confidence: matchedRule.confidenceScore,
      };
    }

    const categories = await dependencies.findCategories(tenantId);
    if (!categories.length) {
      await dependencies.savePending({
        tenantId,
        transactionId,
        reason: "NO_VALID_CATEGORIES",
      });
      return pendingResult(transactionId, "NO_VALID_CATEGORIES");
    }

    let suggestion;
    try {
      suggestion = await dependencies.aiClassifier.suggest({
        transaction: {
          description: transaction.description,
          amount: transaction.amount,
          transactionDate: transaction.transactionDate,
          accountContext: transaction.accountContext,
          direction: transaction.direction,
          operationType: transaction.operationType,
        },
        categories,
      });
    } catch (error) {
      const reason = error instanceof AiClassificationContractError
        ? "AI_INVALID_SUGGESTION" as const
        : "AI_CLASSIFICATION_FAILED" as const;
      await dependencies.savePending({ tenantId, transactionId, reason });
      return pendingResult(transactionId, reason);
    }

    const allowedCategoryIds = new Set(categories.map((category) => category.id));
    if (!allowedCategoryIds.has(suggestion.categoryId)) {
      await dependencies.savePending({
        tenantId,
        transactionId,
        reason: "AI_INVALID_SUGGESTION",
      });
      return pendingResult(transactionId, "AI_INVALID_SUGGESTION");
    }

    const saved = await dependencies.saveAiSuggestion({
      tenantId,
      transactionId,
      categoryId: suggestion.categoryId,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
    });
    if (!saved) {
      await dependencies.savePending({
        tenantId,
        transactionId,
        reason: "AI_INVALID_SUGGESTION",
      });
      return pendingResult(transactionId, "AI_INVALID_SUGGESTION");
    }

    return {
      status: "PENDING_REVIEW",
      transactionId,
      reason: "AI_SUGGESTION",
      suggestedCategoryId: suggestion.categoryId,
      classifiedBy: "AI",
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
    };
  };
}

export function createProductionTransactionClassifier(
  aiClassifier: AiCategoryClassifier = openAiCategoryClassifier,
) {
  return createTransactionClassifier({
    findTransaction: transactionsRepository.findTransactionForClassification,
    async findExisting(tenantId, transactionId) {
      const existing = await classificationRepository.findOutcomeByTransaction(
        tenantId,
        transactionId,
      );
      return existing
        ? {
            status: existing.status,
            classifiedBy: existing.classified_by,
            categoryId: existing.category_id,
            confidence: existing.confidence_score === null
              ? null
              : Number(existing.confidence_score),
            reasoning: existing.reasoning,
          }
        : null;
    },
    findRules: merchantRulesRepository.findCandidates,
    async findCategories(tenantId) {
      return (await categoriesRepository.findActiveByTenant(tenantId)).map(
        (category) => ({
          id: category.id,
          name: category.name,
          categoryType: category.category_type,
          description: category.description,
          parentId: category.parent_id,
        }),
      );
    },
    savePending: classificationRepository.upsertPending,
    saveAiSuggestion: classificationRepository.upsertAiSuggestion,
    applyRule: classificationRepository.applyMerchantRule,
    aiClassifier,
  });
}

const productionClassifier = createProductionTransactionClassifier();

export function classifyTransaction(
  tenantId: string,
  transactionId: string,
) {
  return productionClassifier(tenantId, transactionId);
}

export async function getPendingClassifications(
  tenantId: string,
) {
  const pending = await classificationRepository.findPendingByTenant(tenantId);

  return pending.map((classification) => ({
    classificationId: classification.id,
    transactionId: classification.transaction_id,
    status: "PENDING_REVIEW" as const,
    classifiedBy: classification.classified_by,
    suggestion: classification.categories
      ? {
          categoryId: classification.categories.id,
          categoryName: classification.categories.name,
          categoryType: classification.categories.category_type,
          confidence: classification.confidence_score === null
            ? null
            : Number(classification.confidence_score),
          reasoning: classification.reasoning,
        }
      : null,
    pendingReason: classification.categories
      ? null
      : classification.reasoning,
    createdAt: classification.created_at,
    transaction: {
      description: classification.transactions.description,
      amount: classification.transactions.amount.toFixed(2),
      transactionDate:
        classification.transactions.transaction_date.toISOString().slice(0, 10),
      direction: classification.transactions.direction,
      operationType: classification.transactions.operation_type,
      account: {
        id: classification.transactions.accounts.id,
        name: classification.transactions.accounts.name,
        context: classification.transactions.accounts.account_context,
      },
    },
  }));
}

async function confirmClassificationInternal(
  tenantId: string,
  transactionId: string,
  input: type.ConfirmClassificationInput,
  reviewResolution?: {
    reviewId: string;
    replyMessage: string;
  },
) {
  const pendingClassification =
    await classificationRepository.findPendingByTransaction(
      tenantId,
      transactionId,
    );
  if (!pendingClassification) {
    throw new DomainError(
      "PENDING_CLASSIFICATION_NOT_FOUND",
      `Pending classification not found for transaction ${transactionId}`,
    );
  }

  const category = await categoriesRepository.findById(
    tenantId,
    input.categoryId,
  );

  if (!category) {
    throw new DomainError(
      "CATEGORY_NOT_FOUND",
      `Category ${input.categoryId} not found`,
    );
  }

  const transaction = await transactionsRepository.findTransactionById(
    tenantId,
    transactionId,
  );

  if (!transaction) {
    throw new DomainError(
      "TRANSACTION_NOT_FOUND",
      `Transaction ${transactionId} not found`,
    );
  }
  if (input.createMerchantRule && !input.merchantRule) {
    throw new DomainError(
      "MERCHANT_RULE_DATA_REQUIRED",
      "Merchant rule data is required",
    );
  }

  // Categoria aplicada e regra opcional pertencem à mesma transação de banco.
  const confirmed = await classificationRepository.confirm({
    tenantId,
    transactionId,
    categoryId: input.categoryId,
    ...(reviewResolution && { reviewResolution }),
    ...(input.createMerchantRule && input.merchantRule && {
      merchantRule: {
        pattern: input.merchantRule.pattern,
        matchType: input.merchantRule.matchType,
        accountContext:
          transaction.accounts.account_context as type.AccountContext,
        direction:
          transaction.direction as type.TransactionDirection,
        operationType:
          transaction.operation_type as type.TransactionOperationType,
      },
    }),
  });

  if (!confirmed) {
    throw new DomainError(
      "PENDING_CLASSIFICATION_NOT_FOUND",
      `Transaction ${transactionId} is no longer pending`,
    );
  }

  return {
    status: "CONFIRMED" as const,
    transactionId,
    categoryId: input.categoryId,
    merchantRuleCreated: confirmed.merchantRuleId !== null,
    merchantRuleId: confirmed.merchantRuleId,
  };
}

export function confirmClassification(
  tenantId: string,
  transactionId: string,
  input: type.ConfirmClassificationInput,
) {
  return confirmClassificationInternal(tenantId, transactionId, input);
}

export function confirmClassificationForReview(
  tenantId: string,
  transactionId: string,
  input: type.ConfirmClassificationInput,
  reviewResolution: {
    reviewId: string;
    replyMessage: string;
  },
) {
  return confirmClassificationInternal(
    tenantId,
    transactionId,
    input,
    reviewResolution,
  );
}
