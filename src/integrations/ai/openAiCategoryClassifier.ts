import "dotenv/config";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  AiClassificationContractError,
  type AiCategoryClassifier,
  validateAiCategorySuggestion,
} from "../../core/aiClassification.js";

type StructuredResponsesClient = {
  responses: {
    parse(input: unknown): Promise<{ output_parsed: unknown }>;
  };
};

export type OpenAiCategoryClassifierOptions = {
  client?: StructuredResponsesClient;
  model?: string;
  apiKey?: string;
};

function createClient(apiKey?: string): StructuredResponsesClient {
  const resolvedKey = apiKey ?? process.env.OPENAI_API_KEY;
  if (!resolvedKey) {
    throw new Error(
      "OPENAI_API_KEY não definida. Configure a chave no arquivo .env.",
    );
  }
  return new OpenAI({ apiKey: resolvedKey }) as unknown as StructuredResponsesClient;
}

export function createOpenAiCategoryClassifier(
  options: OpenAiCategoryClassifierOptions = {},
): AiCategoryClassifier {
  return {
    async suggest(input) {
      if (!input.categories.length) {
        throw new AiClassificationContractError(
          "AI_CATEGORIES_EMPTY",
          "Nenhuma categoria válida foi fornecida para a IA.",
        );
      }

      const categoryIds = input.categories.map((category) => category.id);
      const categoryIdSchema = z.enum(
        categoryIds as [string, ...string[]],
      );
      const outputSchema = z.strictObject({
        categoryId: categoryIdSchema,
        // Mantém o JSON Schema da API no subconjunto mais portátil; limites
        // semânticos são validados novamente no domínio logo após a resposta.
        confidence: z.number(),
        reasoning: z.string(),
      });
      const client = options.client ?? createClient(options.apiKey);
      const response = await client.responses.parse({
        model: options.model ??
          process.env.OPENAI_CLASSIFICATION_MODEL ??
          "gpt-4o-mini",
        store: false,
        input: [
          {
            role: "system",
            content: [
              "Você classifica transações financeiras brasileiras.",
              "Escolha exatamente uma categoria da lista fornecida.",
              "Nunca invente, altere ou combine IDs de categorias.",
              "A sugestão será revisada por uma pessoa antes de ser aplicada.",
            ].join(" "),
          },
          {
            role: "user",
            content: JSON.stringify({
              transaction: input.transaction,
              validCategories: input.categories,
            }),
          },
        ],
        text: {
          format: zodTextFormat(
            outputSchema,
            "financial_category_suggestion",
          ),
        },
      });

      return validateAiCategorySuggestion(
        response.output_parsed,
        new Set(categoryIds),
      );
    },
  };
}

export const openAiCategoryClassifier = createOpenAiCategoryClassifier();
