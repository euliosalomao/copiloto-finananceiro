import { prisma } from "../lib/prisma.js";
import {
  AccountContext,
  CreateTransactionInput,
  UpdateTransactionInput,
  TransactionOperationType,
  TransactionForReport,
  CreateTransactionData,
  MerchantRuleRepositoryCreateInput,
  MerchantRuleCandidate,
 } from "../core/schemas/types.js";
import * as types from "../core/schemas/types.js"

type FindCandidatesInput = {
  tenantId: string;
  accountContext: string;
  direction: string;
  operationType: string;
};

export async function findCandidates(
  input: FindCandidatesInput,
): Promise<MerchantRuleCandidate[]> {
  const rules = await prisma.merchant_rules.findMany({
    where: {
      tenant_id: input.tenantId,
      active: true,

      // Uma regra sem categoria não consegue classificar nada
      category_id: {
        not: null,
      },

      AND: [
        {
          OR: [
            {
              account_context:
                input.accountContext,
            },
            {
              account_context: "ANY",
            },
          ],
        },
        {
          OR: [
            {
              direction: input.direction,
            },
            {
              direction: "ANY",
            },
          ],
        },
        {
          OR: [
            {
              operation_type:
                input.operationType,
            },
            {
              operation_type: "ANY",
            },
          ],
        },
      ],
    },

    orderBy: {
      priority: "desc",
    },
  });

  return rules.flatMap((rule) => {
    // O Prisma continua considerando nullable,
    // mesmo tendo filtro no where.
    if (rule.category_id === null) {
      return [];
    }

    return [
      {
        id: rule.id,
        categoryId: rule.category_id,
        pattern: rule.pattern,

        matchType: rule.match_type as
          | "EXACT"
          | "CONTAINS",

        confidenceScore:
          rule.confidence_score === null
            ? null
            : Number(rule.confidence_score),
      },
    ];
  });
}

export async function create(
  input: MerchantRuleRepositoryCreateInput,
) {
  return prisma.merchant_rules.create({
    data: {
      tenant_id: input.tenantId,
      category_id: input.categoryId,

      pattern: input.pattern,
      match_type: input.matchType,

      account_context: input.accountContext,
      direction: input.direction,
      operation_type: input.operationType,

      active: true,
    },

    select: {
      id: true,
      category_id: true,
      pattern: true,
      match_type: true,
      account_context: true,
      direction: true,
      operation_type: true,
      active: true,
    },
  });
}