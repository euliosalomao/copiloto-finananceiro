import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { CsvImportError, parseCsv } from "../core/csvImport.js";
import { DomainError } from "../core/errors.js";
import { createImportService } from "../services/importService.js";

// Opt-in: a suíte comum não abre conexão nem depende do túnel SSH.
test("PostgreSQL: importação CSV, isolamento, concorrência e rollback", {
  skip: process.env.CSV_IMPORT_DB_TESTS !== "1",
}, async (t) => {
  const { prisma } = await import("../lib/prisma.js");
  const { importRepository } = await import("../data/importRepository.js");
  const service = createImportService(importRepository);
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const accountId = randomUUID();
  const secondAccountId = randomUUID();
  const marker = `csv-integration-${randomUUID()}`;
  const header = "transactionDate,description,amount,direction,operationType,externalId";
  const input = (tag: string) => ({
    accountId, allowPossibleDuplicates: false,
    file: Buffer.from(`${header}\n2026-09-01,Compra ${tag},12.34,OUTFLOW,EXPENSE,${tag}\n`),
  });
  const counts = async () => ({
    transactions: await prisma.transactions.count({ where: { tenant_id: tenantId } }),
    classifications: await prisma.transaction_classifications.count({ where: { tenant_id: tenantId } }),
  });
  const isCsvError = (code: string) => (error: unknown) => error instanceof CsvImportError && error.code === code;
  const unavailable = (error: unknown) => error instanceof DomainError && error.code === "ACCOUNT_UNAVAILABLE";

  try {
    await prisma.tenants.createMany({ data: [{ id: tenantId, name: marker }, { id: otherTenantId, name: marker }] });
    await prisma.accounts.createMany({ data: [accountId, secondAccountId].map((id) => ({
      id, tenant_id: tenantId, name: `${marker}-${id}`, institution: "CSV TEST",
      account_context: "PF", account_type: "CHECKING", currency: "BRL",
    })) });

    await t.test("preview não grava; lote com linha inválida não grava a linha válida", async () => {
      const data = input("invalid-batch");
      data.file = Buffer.concat([data.file, Buffer.from("2026-02-30,Inválida,10,OUTFLOW,EXPENSE,bad-date\n")]);
      const preview = await service.preview(tenantId, data);
      assert.equal(preview.summary.validRows, 1);
      assert.equal(preview.summary.invalidRows, 1);
      assert.deepEqual(await counts(), { transactions: 0, classifications: 0 });
      await assert.rejects(service.commit(tenantId, { ...data, previewToken: preview.previewToken }), isCsvError("CSV_INVALID_ROWS"));
      assert.deepEqual(await counts(), { transactions: 0, classifications: 0 });
    });

    await t.test("sucesso grava transação e pendência; reenvio não duplica", async () => {
      const data = input("first");
      const preview = await service.preview(tenantId, data);
      const result = await service.commit(tenantId, { ...data, previewToken: preview.previewToken });
      assert.equal(result.importedCount, 1);
      assert.deepEqual(await counts(), { transactions: 1, classifications: 1 });
      const saved = await prisma.transactions.findUniqueOrThrow({
        where: { id: result.transactionIds[0]! }, include: { transaction_classifications: true },
      });
      assert.equal(saved.amount.toFixed(2), "12.34");
      assert.equal(saved.provider, "CSV");
      assert.equal(saved.is_manual, false);
      assert.equal(saved.reference_month.toISOString(), "2026-09-01T00:00:00.000Z");
      assert.equal(saved.transaction_classifications?.status, "PENDING_REVIEW");
      await assert.rejects(service.commit(tenantId, { ...data, previewToken: preview.previewToken }), isCsvError("CSV_DUPLICATES"));

      // A exclusão lógica não libera o mesmo ID externo para nova importação.
      await prisma.transactions.update({ where: { id: saved.id }, data: { ignored: true } });
      const again = await service.preview(tenantId, data);
      assert.equal(again.summary.duplicateRows, 1);
      assert.equal(again.rows[0]?.duplicates[0]?.ignored, true);
      await assert.rejects(service.commit(tenantId, { ...data, previewToken: again.previewToken, allowPossibleDuplicates: true }), isCsvError("CSV_DUPLICATES"));
    });

    await t.test("mesmo ID externo pode existir em outra conta do tenant", async () => {
      const data = { ...input("first"), accountId: secondAccountId };
      const preview = await service.preview(tenantId, data);
      assert.equal(preview.canImport, true);
      await service.commit(tenantId, { ...data, previewToken: preview.previewToken });
      assert.deepEqual(await counts(), { transactions: 2, classifications: 2 });
    });

    await t.test("conta de outro tenant e conta inativada após o preview são recusadas", async () => {
      const data = input("unavailable");
      await assert.rejects(service.preview(otherTenantId, data), unavailable);
      const preview = await service.preview(tenantId, data);
      await prisma.accounts.update({ where: { id: accountId }, data: { is_active: false } });
      await assert.rejects(service.preview(tenantId, data), unavailable);
      await assert.rejects(service.commit(tenantId, { ...data, previewToken: preview.previewToken }), unavailable);
      await prisma.accounts.update({ where: { id: accountId }, data: { is_active: true } });
      assert.deepEqual(await counts(), { transactions: 2, classifications: 2 });
    });

    await t.test("falha depois de gravar dentro da transação desfaz transações e classificações", async () => {
      const before = await counts();
      const rows = parseCsv(input("rollback").file, accountId).rows;
      await assert.rejects(importRepository.withAccountLock(tenantId, accountId, async (session) => {
        await session.save(rows); // INSERTs executados, mas ainda não confirmados.
        await session.save(rows); // Viola o índice único e obriga rollback de tudo.
      }), (error: unknown) => error instanceof Error && "code" in error && error.code === "P2002");
      assert.deepEqual(await counts(), before);
      assert.equal((await service.preview(tenantId, input("rollback"))).canImport, true);
    });

    await t.test("dois commits simultâneos: um salva e o outro detecta a duplicata", async () => {
      const data = input("concurrent");
      const before = await counts();
      const preview = await service.preview(tenantId, data);
      const results = await Promise.allSettled([
        service.commit(tenantId, { ...data, previewToken: preview.previewToken }),
        service.commit(tenantId, { ...data, previewToken: preview.previewToken }),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected" && isCsvError("CSV_DUPLICATES")(rejected.reason));
      assert.deepEqual(await counts(), { transactions: before.transactions + 1, classifications: before.classifications + 1 });
    });
  } finally {
    try {
      // Só remove fixtures deste teste: UUIDs gerados aqui + marcador conferido.
      const fixtures = await prisma.tenants.findMany({
        where: { id: { in: [tenantId, otherTenantId] }, name: marker }, select: { id: true },
      });
      const ids = fixtures.map((fixture) => fixture.id);
      if (ids.length) {
        await prisma.$transaction(async (tx) => {
          await tx.transactions.deleteMany({ where: { tenant_id: { in: ids } } });
          await tx.accounts.deleteMany({ where: { tenant_id: { in: ids } } });
          await tx.tenants.deleteMany({ where: { id: { in: ids }, name: marker } });
        });
        assert.equal(await prisma.tenants.count({ where: { id: { in: ids } } }), 0);
        t.diagnostic("Fixtures CSV removidas; nenhum dado existente foi usado ou alterado.");
      }
    } finally {
      await prisma.$disconnect();
    }
  }
});
