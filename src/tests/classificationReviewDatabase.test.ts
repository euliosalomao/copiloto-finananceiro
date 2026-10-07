import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

test("PostgreSQL: fila coordena sugestão da IA até a confirmação", {
  skip: process.env.CLASSIFICATION_REVIEW_DB_TESTS !== "1",
}, async () => {
  const { prisma } = await import("../lib/prisma.js");
  const { classificationReviewRepository } = await import(
    "../data/classificationReviewRepository.js"
  );
  const { confirmClassificationForReview } = await import(
    "../services/classificationService.js"
  );
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const suggestionId = randomUUID();
  const marker = `classification-review-${randomUUID()}`;

  try {
    await prisma.tenants.create({ data: { id: tenantId, name: marker } });
    await prisma.accounts.create({
      data: {
        id: accountId,
        tenant_id: tenantId,
        name: marker,
        institution: "INTER",
        account_context: "PF",
        account_type: "CHECKING",
      },
    });
    await prisma.categories.create({
      data: {
        id: suggestionId,
        tenant_id: tenantId,
        name: "Alimentação",
        category_type: "EXPENSE",
      },
    });

    const createTransaction = async (description: string) => {
      const transactionId = randomUUID();
      await prisma.transactions.create({
        data: {
          id: transactionId,
          tenant_id: tenantId,
          account_id: accountId,
          transaction_date: new Date("2026-09-30T00:00:00.000Z"),
          reference_month: new Date("2026-09-01T00:00:00.000Z"),
          description,
          amount: "10.00",
          direction: "OUTFLOW",
          operation_type: "EXPENSE",
        },
      });
      return transactionId;
    };

    const ignoredTransactionId = await createTransaction("Pendência antiga");
    await prisma.transaction_classifications.create({
      data: {
        tenant_id: tenantId,
        transaction_id: ignoredTransactionId,
        status: "PENDING_REVIEW",
        classified_by: "DEFAULT",
        reasoning: "NO_VALID_CATEGORIES",
      },
    });

    const transactionId = await createTransaction("Supermercado BH");
    await prisma.transaction_classifications.create({
      data: {
        tenant_id: tenantId,
        transaction_id: transactionId,
        category_id: suggestionId,
        status: "PENDING_REVIEW",
        classified_by: "AI",
        confidence_score: "87.50",
        reasoning: "Sugestão da IA",
      },
    });

    const claimed = await classificationReviewRepository.claimNext(tenantId);
    assert.equal(claimed.kind, "READY");
    if (claimed.kind !== "READY") return;
    assert.equal(
      claimed.review.transaction_classifications.transaction_id,
      transactionId,
    );
    assert.equal(
      (await classificationReviewRepository.claimNext(tenantId)).kind,
      "CLAIM_IN_PROGRESS",
    );

    const attached = await classificationReviewRepository.attachMessage(
      tenantId,
      claimed.review.id,
      "evolution-message-1",
    );
    assert.equal(attached.kind, "ATTACHED");
    assert.equal(
      (await classificationReviewRepository.claimNext(tenantId)).kind,
      "WAITING_REPLY",
    );

    await confirmClassificationForReview(
      tenantId,
      transactionId,
      { categoryId: suggestionId, createMerchantRule: false },
      { reviewId: claimed.review.id, replyMessage: "sim" },
    );

    const persisted = await prisma.classification_reviews.findUniqueOrThrow({
      where: { id: claimed.review.id },
    });
    assert.equal(persisted.status, "RESOLVED");
    assert.equal(persisted.reply_message, "sim");
    assert.equal(persisted.resolved_category_id, suggestionId);
    assert.equal(
      (await classificationReviewRepository.claimNext(tenantId)).kind,
      "EMPTY",
    );
  } finally {
    const fixture = await prisma.tenants.findFirst({
      where: { id: tenantId, name: marker },
      select: { id: true },
    });
    if (fixture) await prisma.tenants.delete({ where: { id: tenantId } });
    await prisma.$disconnect();
  }
});
