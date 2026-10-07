import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Prisma } from "../generated/prisma/client.js";
import type {
  ClassificationReviewRecord,
  ClassificationReviewRepository,
} from "../data/classificationReviewRepository.js";
import { DomainError } from "../core/errors.js";
import { createClassificationReviewService } from
  "../services/classificationReviewService.js";

const tenantId = randomUUID();
const transactionId = randomUUID();
const classificationId = randomUUID();
const suggestionId = randomUUID();

function review(
  overrides: Partial<ClassificationReviewRecord> = {},
): ClassificationReviewRecord {
  const now = new Date("2026-09-30T12:00:00.000Z");
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    classification_id: classificationId,
    status: "CLAIMED",
    external_message_id: null,
    reply_message: null,
    resolved_category_id: null,
    claimed_at: now,
    claim_expires_at: new Date("2026-09-30T12:15:00.000Z"),
    message_sent_at: null,
    resolved_at: null,
    created_at: now,
    updated_at: now,
    categories: null,
    transaction_classifications: {
      id: classificationId,
      transaction_id: transactionId,
      status: "PENDING_REVIEW",
      classified_by: "AI",
      category_id: suggestionId,
      confidence_score: new Prisma.Decimal("87.50"),
      reasoning: "Descrição compatível com alimentação.",
      categories: {
        id: suggestionId,
        name: "Alimentação",
        category_type: "EXPENSE",
      },
      transactions: {
        id: transactionId,
        description: "Supermercado BH",
        amount: new Prisma.Decimal("74.84"),
        transaction_date: new Date("2026-08-03T00:00:00.000Z"),
        direction: "OUTFLOW",
        operation_type: "EXPENSE",
        accounts: {
          id: randomUUID(),
          name: "Inter PF",
          account_context: "PF",
        },
      },
    },
    ...overrides,
  };
}

function setup(currentReview = review()) {
  const state = {
    confirmed: [] as unknown[],
    nextResult: {
      kind: "EMPTY" as const,
    },
  };
  const reviews: Pick<
    ClassificationReviewRepository,
    "claimNext" | "attachMessage" | "findByExternalMessage"
  > = {
    async claimNext() {
      return state.nextResult;
    },
    async attachMessage(_tenantId, _reviewId, externalMessageId) {
      return {
        kind: "ATTACHED",
        review: review({
          ...currentReview,
          status: "WAITING_REPLY",
          external_message_id: externalMessageId,
          claim_expires_at: null,
          message_sent_at: new Date(),
        }),
      };
    },
    async findByExternalMessage() {
      return currentReview;
    },
  };
  const service = createClassificationReviewService({
    reviews,
    async confirmReview(...args) {
      state.confirmed.push(args);
      return {
        status: "CONFIRMED",
        transactionId,
        categoryId: args[2].categoryId,
        merchantRuleCreated: Boolean(args[2].merchantRule),
        merchantRuleId: args[2].merchantRule ? randomUUID() : null,
      };
    },
  });
  return { service, state, reviews };
}

test("next formata somente os dados necessários para a mensagem", async () => {
  const current = review();
  const { service, reviews } = setup(current);
  reviews.claimNext = async () => ({
    kind: "READY",
    review: current,
    reclaimed: false,
  });

  const result = await service.claimNext(tenantId);
  assert.equal(result.queueState, "READY");
  assert.equal(result.review?.transaction.description, "Supermercado BH");
  assert.equal(result.review?.transaction.amount, "74.84");
  assert.equal(result.review?.suggestion.categoryName, "Alimentação");
  assert.equal(result.review?.suggestion.confidence, 87.5);
});

test("next não entrega outra review enquanto aguarda resposta", async () => {
  const { service, reviews } = setup();
  reviews.claimNext = async () => ({ kind: "WAITING_REPLY" });
  assert.deepEqual(await service.claimNext(tenantId), {
    queueState: "WAITING_REPLY",
    review: null,
  });
});

test("resposta aceita a sugestão, resolve e tenta reivindicar a próxima", async () => {
  const current = review({
    status: "WAITING_REPLY",
    external_message_id: "message-1",
    claim_expires_at: null,
    message_sent_at: new Date(),
  });
  const { service, state } = setup(current);
  const result = await service.reply(tenantId, {
    quotedMessageId: "message-1",
    message: "sim",
    action: "ACCEPT_SUGGESTION",
    createMerchantRule: false,
  });

  assert.equal(result.resolved.categoryId, suggestionId);
  assert.equal(result.queueState, "EMPTY");
  assert.equal(result.next, null);
  const confirmation = state.confirmed[0] as unknown[];
  assert.equal((confirmation[2] as { categoryId: string }).categoryId, suggestionId);
  assert.deepEqual(confirmation[3], {
    reviewId: current.id,
    replyMessage: "sim",
  });
});

test("resposta pode trocar categoria e criar merchant rule", async () => {
  const chosenCategoryId = randomUUID();
  const current = review({
    status: "WAITING_REPLY",
    external_message_id: "message-2",
    claim_expires_at: null,
    message_sent_at: new Date(),
  });
  const { service, state } = setup(current);
  const result = await service.reply(tenantId, {
    quotedMessageId: "message-2",
    message: "não, lazer",
    action: "CHANGE_CATEGORY",
    categoryId: chosenCategoryId,
    createMerchantRule: true,
    merchantRule: {
      pattern: "STEAM",
      matchType: "CONTAINS",
    },
  });

  assert.equal(result.resolved.categoryId, chosenCategoryId);
  assert.equal(result.resolved.merchantRuleCreated, true);
  const confirmation = state.confirmed[0] as unknown[];
  assert.deepEqual(confirmation[2], {
    categoryId: chosenCategoryId,
    createMerchantRule: true,
    merchantRule: { pattern: "STEAM", matchType: "CONTAINS" },
  });
});

test("reply duplicado de review resolvida é idempotente", async () => {
  const current = review({
    status: "RESOLVED",
    external_message_id: "message-3",
    resolved_category_id: suggestionId,
    reply_message: "sim",
    claim_expires_at: null,
    message_sent_at: new Date(),
    resolved_at: new Date(),
  });
  const { service, state } = setup(current);
  const result = await service.reply(tenantId, {
    quotedMessageId: "message-3",
    message: "sim",
    action: "ACCEPT_SUGGESTION",
    createMerchantRule: false,
  });

  assert.equal(result.resolved.alreadyResolved, true);
  assert.equal(result.next, null);
  assert.equal(state.confirmed.length, 0);
});

test("reply exige uma review associada e aguardando resposta", async () => {
  const current = review({ status: "CLAIMED" });
  const { service } = setup(current);
  await assert.rejects(
    service.reply(tenantId, {
      quotedMessageId: "message-4",
      message: "sim",
      action: "ACCEPT_SUGGESTION",
      createMerchantRule: false,
    }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "CLASSIFICATION_REVIEW_NOT_WAITING",
  );
});
