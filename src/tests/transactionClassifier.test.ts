import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { TransactionClassifierDependencies } from "../services/classificationService.js";
import { createTransactionClassifier } from "../services/classificationService.js";

const tenantId = randomUUID();
const transactionId = randomUUID();
const categoryId = randomUUID();

function setup(options: {
  existing?: Awaited<ReturnType<TransactionClassifierDependencies["findExisting"]>>;
  rules?: Awaited<ReturnType<TransactionClassifierDependencies["findRules"]>>;
  aiCategoryId?: string;
  aiError?: Error;
  categories?: Awaited<ReturnType<TransactionClassifierDependencies["findCategories"]>>;
} = {}) {
  const state = {
    aiCalls: 0,
    savedSuggestions: [] as unknown[],
    pendingReasons: [] as string[],
    appliedRules: 0,
  };
  const dependencies: TransactionClassifierDependencies = {
    async findTransaction() {
      return {
        id: transactionId,
        description: "MERCADO EXEMPLO",
        amount: "25.90",
        transactionDate: "2026-09-01",
        accountContext: "PF",
        direction: "OUTFLOW",
        operationType: "EXPENSE",
      };
    },
    async findExisting() {
      return options.existing ?? null;
    },
    async findRules() {
      return options.rules ?? [];
    },
    async findCategories() {
      return options.categories ?? [{
        id: categoryId,
        name: "Mercado",
        categoryType: "EXPENSE",
        description: null,
        parentId: null,
      }];
    },
    async savePending(input) {
      state.pendingReasons.push(input.reason);
      return input;
    },
    async saveAiSuggestion(input) {
      state.savedSuggestions.push(input);
      return input;
    },
    async applyRule() {
      state.appliedRules++;
      return {};
    },
    aiClassifier: {
      async suggest() {
        state.aiCalls++;
        if (options.aiError) throw options.aiError;
        return {
          categoryId: options.aiCategoryId ?? categoryId,
          confidence: 87,
          reasoning: "Compatível com a descrição.",
        };
      },
    },
  };

  return {
    classify: createTransactionClassifier(dependencies),
    state,
  };
}

test("sem regra, salva sugestão da IA como pendente", async () => {
  const { classify, state } = setup();
  const result = await classify(tenantId, transactionId);

  assert.equal(result.status, "PENDING_REVIEW");
  assert.ok(result.status === "PENDING_REVIEW" && result.reason === "AI_SUGGESTION");
  assert.equal(state.aiCalls, 1);
  assert.equal(state.savedSuggestions.length, 1);
  assert.deepEqual(state.pendingReasons, []);
});

test("categoria inventada é rejeitada e não vira sugestão", async () => {
  const { classify, state } = setup({ aiCategoryId: randomUUID() });
  const result = await classify(tenantId, transactionId);

  assert.deepEqual(result, {
    status: "PENDING_REVIEW",
    transactionId,
    reason: "AI_INVALID_SUGGESTION",
  });
  assert.equal(state.savedSuggestions.length, 0);
  assert.deepEqual(state.pendingReasons, ["AI_INVALID_SUGGESTION"]);
});

test("sugestão de IA já existente não chama o modelo novamente", async () => {
  const { classify, state } = setup({
    existing: {
      status: "PENDING_REVIEW",
      classifiedBy: "AI",
      categoryId,
      confidence: 82,
      reasoning: "Sugestão anterior.",
    },
  });
  const result = await classify(tenantId, transactionId);

  assert.equal(result.status, "PENDING_REVIEW");
  assert.ok(result.status === "PENDING_REVIEW" && result.reason === "AI_SUGGESTION");
  assert.equal(state.aiCalls, 0);
  assert.equal(state.savedSuggestions.length, 0);
});

test("merchant rule tem prioridade e evita chamada à IA", async () => {
  const { classify, state } = setup({
    rules: [{
      id: randomUUID(),
      categoryId,
      pattern: "MERCADO",
      matchType: "CONTAINS",
      confidenceScore: 98,
    }],
  });
  const result = await classify(tenantId, transactionId);

  assert.equal(result.status, "CLASSIFIED");
  assert.equal(state.appliedRules, 1);
  assert.equal(state.aiCalls, 0);
});

test("falha do provedor vira pendência reprocessável", async () => {
  const { classify, state } = setup({ aiError: new Error("indisponível") });
  const result = await classify(tenantId, transactionId);

  assert.deepEqual(result, {
    status: "PENDING_REVIEW",
    transactionId,
    reason: "AI_CLASSIFICATION_FAILED",
  });
  assert.deepEqual(state.pendingReasons, ["AI_CLASSIFICATION_FAILED"]);
});
