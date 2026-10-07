import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type {
  ImportBatch,
  ImportBatchesRepository,
} from "../data/importBatchesRepository.js";
import type { StatementImportRepository } from "../data/statementImportRepository.js";
import { bankStatementParserRegistry } from "../integrations/bankStatements/index.js";
import {
  createStatementImportService,
  StatementImportError,
} from "../services/statementImportService.js";

const file = readFileSync(new URL(
  "./fixtures/bank-statements/inter-checking-anonymized.csv",
  import.meta.url,
));
const tenantId = randomUUID();
const accountId = randomUUID();

function batch(overrides: Partial<ImportBatch> = {}): ImportBatch {
  const now = new Date();
  return {
    id: randomUUID(),
    tenant_id: tenantId,
    account_id: accountId,
    provider: "INTER",
    format: "INTER_CSV",
    source: "MANUAL",
    source_message_id: null,
    source_attachment_id: null,
    file_hash: "a".repeat(64),
    status: "PROCESSING",
    total_transactions: 0,
    imported_count: 0,
    duplicate_count: 0,
    possible_duplicate_count: 0,
    failed_count: 0,
    error_code: null,
    error_message: null,
    metadata: null,
    started_at: now,
    finished_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function setup(options: {
  duplicate?: boolean;
  classificationFailureAt?: number;
} = {}) {
  const currentBatch = batch();
  const state = {
    persisted: 0,
    classified: [] as string[],
    markedImported: 0,
    markedNeedsReview: 0,
  };
  const batches: ImportBatchesRepository = {
    async claim() {
      return options.duplicate
        ? { kind: "FILE_DUPLICATE", batch: currentBatch }
        : { kind: "CREATED", batch: currentBatch };
    },
    async markImported(input) {
      state.markedImported++;
      return batch({
        id: input.batchId,
        status: "IMPORTED",
        total_transactions: input.totalTransactions,
        imported_count: input.importedCount,
        duplicate_count: input.duplicateCount,
        failed_count: input.failedCount,
        finished_at: new Date(),
      });
    },
    async markNeedsReview(input) {
      state.markedNeedsReview++;
      return batch({
        id: input.batchId,
        status: "NEEDS_REVIEW",
        total_transactions: input.totalTransactions,
        imported_count: input.importedCount,
        duplicate_count: input.duplicateCount,
        failed_count: input.failedCount,
        finished_at: new Date(),
      });
    },
    async markFailed() {
      return batch({ status: "FAILED", finished_at: new Date() });
    },
    async findById() {
      return currentBatch;
    },
  };
  const repository: StatementImportRepository = {
    async assertAccountAvailable() {},
    async persist(input) {
      state.persisted++;
      assert.equal(input.statement.provider, "INTER");
      assert.equal(input.transactions.length, 7);
      assert.equal(new Set(input.transactions.map((item) => item.identityKey)).size, 7);
      return {
        transactionIds: input.transactions.map(() => randomUUID()),
        duplicateCount: 0,
      };
    },
  };
  const service = createStatementImportService({
    parserRegistry: bankStatementParserRegistry,
    batches,
    repository,
    async classifyTransaction(_tenant, transactionId) {
      state.classified.push(transactionId);
      if (state.classified.length === options.classificationFailureAt) {
        throw new Error("falha simulada");
      }
      return state.classified.length === 1
        ? {
            status: "CLASSIFIED",
            transactionId,
            categoryId: randomUUID(),
            ruleId: randomUUID(),
            classifiedBy: "RULE",
            confidence: 95,
          }
        : {
            status: "PENDING_REVIEW",
            transactionId,
            reason: "NO_MATCHING_MERCHANT_RULE",
          };
    },
  });

  return { service, state };
}

const input = () => ({
  accountId,
  format: "INTER_CSV" as const,
  source: "MANUAL" as const,
  file,
  fileName: "extrato.csv",
  mimeType: "text/csv",
});

test("extrato passa pelo registry, persiste fingerprints e classifica apenas as novas", async () => {
  const { service, state } = setup();
  const result = await service.import(tenantId, input());

  assert.equal(result.provider, "INTER");
  assert.equal(result.totalTransactions, 7);
  assert.equal(result.importedCount, 7);
  assert.equal(result.classifiedCount, 1);
  assert.equal(result.pendingReviewCount, 6);
  assert.equal(result.classificationFailedCount, 0);
  assert.equal(result.batchStatus, "IMPORTED");
  assert.equal(state.persisted, 1);
  assert.equal(state.classified.length, 7);
  assert.equal(state.markedImported, 1);
});

test("falha isolada do classificador não perde a importação e sinaliza revisão", async () => {
  const { service, state } = setup({ classificationFailureAt: 2 });
  const result = await service.import(tenantId, input());

  assert.equal(result.importedCount, 7);
  assert.equal(result.classificationFailedCount, 1);
  assert.equal(result.batchStatus, "NEEDS_REVIEW");
  assert.equal(state.markedNeedsReview, 1);
});

test("arquivo já reivindicado para antes do parser e da persistência", async () => {
  const { service, state } = setup({ duplicate: true });
  await assert.rejects(
    service.import(tenantId, input()),
    (error: unknown) =>
      error instanceof StatementImportError &&
      error.code === "FILE_DUPLICATE" &&
      error.statusCode === 409,
  );
  assert.equal(state.persisted, 0);
  assert.equal(state.classified.length, 0);
});
