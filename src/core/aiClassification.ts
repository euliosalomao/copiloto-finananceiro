import { z } from "zod";

export type AiCategoryCandidate = {
  id: string;
  name: string;
  categoryType: string;
  description: string | null;
  parentId: string | null;
};

export type AiTransactionContext = {
  description: string;
  amount: string;
  transactionDate: string;
  accountContext: string;
  direction: string;
  operationType: string;
};

export type AiCategorySuggestion = {
  categoryId: string;
  confidence: number;
  reasoning: string;
};

export type AiCategoryClassifier = {
  suggest(input: {
    transaction: AiTransactionContext;
    categories: readonly AiCategoryCandidate[];
  }): Promise<AiCategorySuggestion>;
};

export class AiClassificationContractError extends Error {
  constructor(
    public readonly code:
      | "AI_CATEGORIES_EMPTY"
      | "AI_OUTPUT_INVALID"
      | "AI_CATEGORY_NOT_ALLOWED",
    message: string,
  ) {
    super(message);
    this.name = "AiClassificationContractError";
  }
}

export const aiCategorySuggestionSchema = z.strictObject({
  categoryId: z.uuid(),
  confidence: z.number().min(0).max(100),
  reasoning: z.string().trim().min(1).max(500),
});

export function validateAiCategorySuggestion(
  value: unknown,
  allowedCategoryIds: ReadonlySet<string>,
): AiCategorySuggestion {
  const parsed = aiCategorySuggestionSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiClassificationContractError(
      "AI_OUTPUT_INVALID",
      "A IA devolveu uma sugestão fora do contrato esperado.",
    );
  }
  if (!allowedCategoryIds.has(parsed.data.categoryId)) {
    throw new AiClassificationContractError(
      "AI_CATEGORY_NOT_ALLOWED",
      "A IA sugeriu uma categoria que não pertence à lista permitida.",
    );
  }
  return parsed.data;
}
