import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { calculateFileHash } from "../core/importFingerprint.js";

test("PostgreSQL: lote é idempotente por origem e arquivo", {
  skip: process.env.IMPORT_BATCH_DB_TESTS !== "1",
}, async () => {
  const { prisma } = await import("../lib/prisma.js");
  const { importBatchesRepository } = await import("../data/importBatchesRepository.js");
  const tenantId = randomUUID();
  const accountId = randomUUID();
  const marker = `import-batch-${randomUUID()}`;
  const firstHash = calculateFileHash(Buffer.from("primeiro arquivo"));
  const otherHash = calculateFileHash(Buffer.from("outro arquivo"));
  const claim = (overrides: Record<string, unknown> = {}) => ({
    tenantId,
    accountId,
    provider: "INTER",
    format: "INTER_CSV",
    source: "GMAIL",
    sourceMessageId: "message-1",
    sourceAttachmentId: "attachment-1",
    fileHash: firstHash,
    metadata: { marker },
    ...overrides,
  });

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
        currency: "BRL",
      },
    });

    const created = await importBatchesRepository.claim(claim());
    assert.equal(created.kind, "CREATED");

    const sameSource = await importBatchesRepository.claim(claim());
    assert.equal(sameSource.kind, "SOURCE_DUPLICATE");
    assert.equal(sameSource.batch.id, created.batch.id);

    const sourceConflict = await importBatchesRepository.claim(claim({ fileHash: otherHash }));
    assert.equal(sourceConflict.kind, "SOURCE_CONFLICT");

    const sameFile = await importBatchesRepository.claim(claim({
      sourceMessageId: "message-2",
      sourceAttachmentId: "attachment-2",
    }));
    assert.equal(sameFile.kind, "FILE_DUPLICATE");
    assert.equal(sameFile.batch.id, created.batch.id);

    const failed = await importBatchesRepository.markFailed({
      tenantId,
      batchId: created.batch.id,
      failedCount: 1,
      errorCode: "INTER_CSV_BALANCE_MISMATCH",
      errorMessage: "falha simulada",
    });
    assert.equal(failed?.status, "FAILED");

    const retried = await importBatchesRepository.claim(claim());
    assert.equal(retried.kind, "CREATED");
    assert.equal(retried.batch.id, created.batch.id);
    assert.equal(retried.batch.status, "PROCESSING");
    assert.equal(retried.batch.error_code, null);
    assert.equal(retried.batch.finished_at, null);

    const finished = await importBatchesRepository.markImported({
      tenantId,
      batchId: created.batch.id,
      totalTransactions: 218,
      importedCount: 210,
      duplicateCount: 8,
      possibleDuplicateCount: 0,
      failedCount: 0,
    });
    assert.equal(finished?.status, "IMPORTED");
    assert.equal(finished?.imported_count, 210);
    assert.ok(finished?.finished_at instanceof Date);
    assert.equal(await importBatchesRepository.markImported({
      tenantId,
      batchId: created.batch.id,
      totalTransactions: 218,
      importedCount: 210,
      duplicateCount: 8,
      possibleDuplicateCount: 0,
      failedCount: 0,
    }), null);

    const concurrentInput = claim({
      sourceMessageId: "message-concurrent",
      sourceAttachmentId: "attachment-concurrent",
      fileHash: calculateFileHash(Buffer.from("arquivo concorrente")),
    });
    const concurrent = await Promise.all([
      importBatchesRepository.claim(concurrentInput),
      importBatchesRepository.claim(concurrentInput),
    ]);
    assert.equal(concurrent.filter((result) => result.kind === "CREATED").length, 1);
    assert.equal(concurrent.filter((result) => result.kind === "SOURCE_DUPLICATE").length, 1);
  } finally {
    const fixture = await prisma.tenants.findFirst({
      where: { id: tenantId, name: marker },
      select: { id: true },
    });
    if (fixture) {
      await prisma.tenants.delete({ where: { id: tenantId } });
    }
    await prisma.$disconnect();
  }
});
