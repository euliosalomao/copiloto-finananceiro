import { z } from "zod";

import {
  accountContextSchema,
  transactionDirectionSchema,
  categorySchema,
  categoryTypeSchema,
  transactionOperationTypeSchema,
  transactionStatusSchema,
  transactionDateSchema,
  createTransactionBodySchema,
  transactionForReportSchema,
  updateTransactionSchema,
  transactionParamsSchema,
  reportQueryStringSchema,
  domainErrorCodeSchema,
} from "./zod.js";

export type AccountContext =
  z.infer<typeof accountContextSchema>;

export type TransactionDirection =
  z.infer<typeof transactionDirectionSchema>;

export type Category =
  z.infer<typeof categorySchema>;

export type CategoryType =
  z.infer<typeof categoryTypeSchema>;

export type CreateCategoryInput = {
  name: string;
  categoryType: CategoryType;
  parentId?: string | null;
  description?: string | null;
};

export type TransactionOperationType =
  z.infer<typeof transactionOperationTypeSchema>;

export type TransactionStatus =
  z.infer<typeof transactionStatusSchema>;

export type TransactionDate =
  z.infer<typeof transactionDateSchema>;

// Dados que chegam no POST
export type CreateTransactionInput =
  z.infer<typeof createTransactionBodySchema>;

// Dados já preparados para os cálculos
export type TransactionForReport =
  z.infer<typeof transactionForReportSchema>;

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

export type TransactionParams = z.infer<typeof transactionParamsSchema>;

export type ReportQueryString = z.infer<typeof reportQueryStringSchema>

export type CreateTransactionData =
  CreateTransactionInput & {
    referenceMonth: Date;
  };
  
export type DomainErrorCode = z.infer< typeof domainErrorCodeSchema >

export type MerchantRuleCandidate = {
  id: string;
  categoryId: string;
  pattern: string;
  matchType: "EXACT" | "CONTAINS";
  confidenceScore: number | null;
};

export type UpsertPendingInput = {
  tenantId: string;
  transactionId: string;
  reason:
    | "NO_MATCHING_MERCHANT_RULE"
    | "NO_VALID_CATEGORIES"
    | "AI_CLASSIFICATION_FAILED"
    | "AI_INVALID_SUGGESTION";
};

export type UpsertAiSuggestionInput = {
  tenantId: string;
  transactionId: string;
  categoryId: string;
  confidence: number;
  reasoning: string;
};

export type ApplyMerchantRuleInput = {
  tenantId: string;
  transactionId: string;
  rule: MerchantRuleCandidate;
};

export type ClassificationResult =
  | {
      status: "PENDING_REVIEW";
      transactionId: string;
      reason:
        | "NO_MATCHING_MERCHANT_RULE"
        | "NO_VALID_CATEGORIES"
        | "AI_CLASSIFICATION_FAILED"
        | "AI_INVALID_SUGGESTION";
    }
  | {
      status: "PENDING_REVIEW";
      transactionId: string;
      reason: "AI_SUGGESTION";
      suggestedCategoryId: string;
      classifiedBy: "AI";
      confidence: number | null;
      reasoning: string | null;
    }
  | {
      status: "CLASSIFIED";
      transactionId: string;
      categoryId: string;
      ruleId: string;
      classifiedBy: "RULE";
      confidence: number | null;
    }
  | {
      status: "ALREADY_PROCESSED";
      transactionId: string;
      classificationStatus: string;
      classifiedBy: string;
      categoryId: string | null;
    };

export type ConfirmClassificationInput = {
  categoryId: string;

  createMerchantRule: boolean;

  merchantRule?: {
    pattern: string;
    matchType: "EXACT" | "CONTAINS";
  };
};

export type ConfirmClassificationRepositoryInput = {
  tenantId: string;
  transactionId: string;
  categoryId: string;
  merchantRule?: {
    pattern: string;
    matchType: "EXACT" | "CONTAINS";
    accountContext: AccountContext;
    direction: TransactionDirection;
    operationType: TransactionOperationType;
  };
  reviewResolution?: {
    reviewId: string;
    replyMessage: string;
  };
};

export type MerchantRuleRepositoryCreateInput = {
  tenantId: string,
  categoryId: string,
  pattern: string,
  matchType: "EXACT" | "CONTAINS",
  accountContext: AccountContext,
  direction: TransactionDirection,
  operationType: TransactionOperationType,
};

export type TransactionForClassification = {
  id: string;
  description: string;
  amount: string;
  transactionDate: string;
  accountContext: AccountContext;
  direction: TransactionDirection;
  operationType: TransactionOperationType;
};
