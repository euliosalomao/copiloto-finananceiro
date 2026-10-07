import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { StatementImportError } from "../services/statementImportService.js";

test("PostgreSQL: statement importa, classifica e não duplica transações", {
  skip: process.env.STATEMENT_IMPORT_DB_TESTS !== "1",
}, async () => {
  const { prisma } = await import("../lib/prisma.js");
  const { bankStatementParserRegistry } = await import("../integrations/bankStatements/index.js");
  const { importBatchesRepository } = await import("../data/importBatchesRepository.js");
  const { statementImportRepository } = await import("../data/statementImportRepository.js");
  const {
    confirmClassification,
    createProductionTransactionClassifier,
    getPendingClassifications,
  } = await import("../services/classificationService.js");
  const { createStatementImportService } = await import("../services/statementImportService.js");
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const categoryId = randomUUID();
  let aiCalls = 0;
  const classifyTransaction = createProductionTransactionClassifier({
    async suggest() {
      aiCalls++;
      return {
        categoryId,
        confidence: 80,
        reasoning: "Sugestão determinística do teste.",
      };
    },
  });
  const service = createStatementImportService({
    parserRegistry: bankStatementParserRegistry,
    batches: importBatchesRepository,
    repository: statementImportRepository,
    classifyTransaction,
  });
  const marker = `statement-import-${randomUUID()}`;
  let fixtureCreated = false;
  const file = readFileSync(new URL(
    "./fixtures/bank-statements/inter-checking-anonymized.csv",
    import.meta.url,
  ));
  const input = (overrides: Record<string, unknown> = {}) => ({
    accountId,
    format: "INTER_CSV" as const,
    source: "GMAIL" as const,
    sourceMessageId: "message-1",
    sourceAttachmentId: "attachment-1",
    file,
    fileName: "extrato.csv",
    mimeType: "text/csv",
    ...overrides,
  });

  try {
    await prisma.tenants.create({ data: { id: tenantId, name: marker } });
    fixtureCreated = true;
    await prisma.accounts.create({
      data: {
        id: accountId,
        tenant_id: tenantId,
        name: marker,
        institution: "INTER",
        account_context: "PF",
        account_type: "CHECKING",
        currency: "BRL",
      },
    });
    await prisma.categories.create({
      data: {
        id: categoryId,
        tenant_id: tenantId,
        name: `${marker}-receita`,
        category_type: "INCOME",
      },
    });
    await prisma.merchant_rules.create({
      data: {
        tenant_id: tenantId,
        category_id: categoryId,
        pattern: "CLIENTE EXEMPLO",
        match_type: "EXACT",
        account_context: "PF",
        direction: "INFLOW",
        operation_type: "INCOME",
        priority: 100,
        confidence_score: 99,
      },
    });

    const first = await service.import(tenantId, input());
    assert.equal(first.totalTransactions, 7);
    assert.equal(first.importedCount, 7);
    assert.equal(first.duplicateCount, 0);
    assert.equal(first.classifiedCount, 1);
    assert.equal(first.pendingReviewCount, 6);
    assert.equal(first.batchStatus, "IMPORTED");

    const saved = await prisma.transactions.findMany({
      where: { tenant_id: tenantId },
      include: { transaction_classifications: true },
    });
    assert.equal(saved.length, 7);
    assert.equal(saved.filter((row) =>
      row.transaction_classifications?.status === "CLASSIFIED").length, 1);
    const classified = saved.find((row) =>
      row.transaction_classifications?.status === "CLASSIFIED");
    assert.equal(classified?.primary_category_id, categoryId);
    assert.equal(classified?.transaction_classifications?.category_id, categoryId);
    assert.ok(saved.filter((row) =>
      row.transaction_classifications?.status === "PENDING_REVIEW")
      .every((row) => row.primary_category_id === null));
    assert.equal(aiCalls, 6);

    const pendingContract = await getPendingClassifications(tenantId);
    assert.equal(pendingContract.length, 6);
    assert.ok(pendingContract.every((item) =>
      item.status === "PENDING_REVIEW" &&
      item.classifiedBy === "AI" &&
      item.suggestion?.categoryId === categoryId &&
      item.transaction.amount.length > 0));

    const pending = saved.find((row) =>
      row.transaction_classifications?.status === "PENDING_REVIEW");
    assert.ok(pending);
    const confirmation = await confirmClassification(
      tenantId,
      pending.id,
      {
        categoryId,
        createMerchantRule: true,
        merchantRule: {
          pattern: pending.description,
          matchType: "EXACT",
        },
      },
    );
    assert.equal(confirmation.merchantRuleCreated, true);
    const confirmed = await prisma.transactions.findUniqueOrThrow({
      where: { id: pending.id },
      include: { transaction_classifications: true },
    });
    assert.equal(confirmed.primary_category_id, categoryId);
    assert.equal(confirmed.transaction_classifications?.classified_by, "USER");
    assert.equal(await prisma.merchant_rules.count({
      where: { id: confirmation.merchantRuleId ?? undefined, tenant_id: tenantId },
    }), 1);

    await assert.rejects(
      service.import(tenantId, input()),
      (error: unknown) =>
        error instanceof StatementImportError &&
        error.code === "SOURCE_DUPLICATE",
    );

    // Bytes diferentes e nova origem, mas mesmas sete movimentações: a camada
    // de fingerprint das transações impede duplicação.
    const overlap = await service.import(tenantId, input({
      sourceMessageId: "message-2",
      sourceAttachmentId: "attachment-2",
      file: Buffer.concat([file, Buffer.from("\r\n")]),
    }));
    assert.equal(overlap.importedCount, 0);
    assert.equal(overlap.duplicateCount, 7);
    assert.equal(await prisma.transactions.count({ where: { tenant_id: tenantId } }), 7);
    assert.equal(aiCalls, 6);
  } finally {
    if (fixtureCreated) {
      const fixture = await prisma.tenants.findFirst({
        where: { id: tenantId, name: marker },
        select: { id: true },
      });
      if (fixture) await prisma.tenants.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }
});
