import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AiClassificationContractError } from "../core/aiClassification.js";
import { createOpenAiCategoryClassifier } from "../integrations/ai/openAiCategoryClassifier.js";

const categoryId = randomUUID();
const input = {
  transaction: {
    description: "MERCADO EXEMPLO",
    amount: "25.90",
    transactionDate: "2026-09-01",
    accountContext: "PF",
    direction: "OUTFLOW",
    operationType: "EXPENSE",
  },
  categories: [{
    id: categoryId,
    name: "Mercado",
    categoryType: "EXPENSE",
    description: "Compras de supermercado",
    parentId: null,
  }],
};

test("envia somente categorias fornecidas e aceita retorno estruturado", async () => {
  let request: unknown;
  const classifier = createOpenAiCategoryClassifier({
    model: "modelo-teste",
    client: {
      responses: {
        async parse(received) {
          request = received;
          return {
            output_parsed: {
              categoryId,
              confidence: 91,
              reasoning: "Descrição compatível com supermercado.",
            },
          };
        },
      },
    },
  });

  const suggestion = await classifier.suggest(input);
  assert.equal(suggestion.categoryId, categoryId);
  const payload = request as {
    model: string;
    store: boolean;
    input: Array<{ role: string; content: string }>;
  };
  assert.equal(payload.model, "modelo-teste");
  assert.equal(payload.store, false);
  const userData = JSON.parse(payload.input[1]!.content);
  assert.deepEqual(userData.validCategories, input.categories);
  assert.equal("tenantId" in userData, false);
});

test("rejeita categoria inventada mesmo se o transporte devolver JSON", async () => {
  const classifier = createOpenAiCategoryClassifier({
    client: {
      responses: {
        async parse() {
          return {
            output_parsed: {
              categoryId: randomUUID(),
              confidence: 99,
              reasoning: "Categoria inventada.",
            },
          };
        },
      },
    },
  });

  await assert.rejects(
    classifier.suggest(input),
    (error: unknown) =>
      error instanceof AiClassificationContractError &&
      error.code === "AI_CATEGORY_NOT_ALLOWED",
  );
});

test("não chama a API quando não existem categorias válidas", async () => {
  let calls = 0;
  const classifier = createOpenAiCategoryClassifier({
    client: {
      responses: {
        async parse() {
          calls++;
          return { output_parsed: null };
        },
      },
    },
  });

  await assert.rejects(
    classifier.suggest({ ...input, categories: [] }),
    (error: unknown) =>
      error instanceof AiClassificationContractError &&
      error.code === "AI_CATEGORIES_EMPTY",
  );
  assert.equal(calls, 0);
});
