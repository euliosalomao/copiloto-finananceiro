import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import Fastify from "fastify";
import { registerErrorHandler } from "../http/routes/errorHandler.js";
import { statementImportRoutes } from "../http/routes/routes/statementImportRoutes.js";
import type { StatementImportService } from "../services/statementImportService.js";

const tenantId = randomUUID();
const accountId = randomUUID();
const previousTenant = process.env.DEFAULT_TENANT_ID;

before(() => { process.env.DEFAULT_TENANT_ID = tenantId; });
after(() => {
  if (previousTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = previousTenant;
});

async function upload(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", new Blob(["conteúdo"], { type: "text/csv" }), "extrato.csv");
  form.append("accountId", accountId);
  form.append("format", "INTER_CSV");
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new Request("http://local", { method: "POST", body: form });
  return {
    headers: { "content-type": request.headers.get("content-type")! },
    payload: Buffer.from(await request.arrayBuffer()),
  };
}

test("rota de statement recebe formato e metadados de origem sem conhecer o Inter", async (t) => {
  const received: unknown[] = [];
  const service = {
    async import(receivedTenant: string, input: unknown) {
      received.push({ receivedTenant, input });
      return {
        batchId: randomUUID(),
        batchStatus: "IMPORTED",
        format: "INTER_CSV",
        provider: "INTER",
        totalTransactions: 1,
        importedCount: 1,
        duplicateCount: 0,
        transactionIds: [randomUUID()],
        issues: [],
        classifiedCount: 0,
        pendingReviewCount: 1,
        classificationFailedCount: 0,
        failedTransactionIds: [],
      };
    },
  } as StatementImportService;
  const app = Fastify();
  registerErrorHandler(app);
  app.register(statementImportRoutes, { service });
  t.after(() => app.close());

  const response = await app.inject({
    method: "POST",
    url: "/imports/statements",
    ...await upload({
      source: "GMAIL",
      sourceMessageId: "message-1",
      sourceAttachmentId: "attachment-1",
    }),
  });

  assert.equal(response.statusCode, 201, response.body);
  assert.equal(received.length, 1);
  const call = received[0] as {
    receivedTenant: string;
    input: Record<string, unknown>;
  };
  assert.equal(call.receivedTenant, tenantId);
  assert.equal(call.input.format, "INTER_CSV");
  assert.equal(call.input.source, "GMAIL");
  assert.equal(call.input.sourceMessageId, "message-1");
  assert.equal(call.input.fileName, "extrato.csv");
});

test("rota não aceita attachment sem message", async (t) => {
  const service = { async import() { throw new Error("não deveria chamar"); } } as StatementImportService;
  const app = Fastify();
  registerErrorHandler(app);
  app.register(statementImportRoutes, { service });
  t.after(() => app.close());

  const missingMessage = await app.inject({
    method: "POST",
    url: "/imports/statements",
    ...await upload({ sourceAttachmentId: "attachment-1" }),
  });
  assert.equal(missingMessage.statusCode, 400, missingMessage.body);
});
