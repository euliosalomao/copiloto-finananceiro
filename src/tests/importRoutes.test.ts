import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import Fastify from "fastify";
import { CSV_MAX_BYTES, type CsvPreview, type CsvRow, type ImportCandidate } from "../core/csvImport.js";
import { createImportService, type ImportRepository } from "../services/importService.js";
import { importRoutes } from "../http/routes/routes/importRoutes.js";
import { registerErrorHandler } from "../http/routes/errorHandler.js";

const tenantId = randomUUID();
const accountId = randomUUID();
const previousTenant = process.env.DEFAULT_TENANT_ID;
before(() => { process.env.DEFAULT_TENANT_ID = tenantId; });
after(() => {
  if (previousTenant === undefined) delete process.env.DEFAULT_TENANT_ID;
  else process.env.DEFAULT_TENANT_ID = previousTenant;
});
const header = "transactionDate,description,amount,direction,operationType";
const validCsv = `${header}\n2026-09-01,Mercado,12.34,OUTFLOW,EXPENSE\n`;

function setup() {
  const state = { saved: [] as ImportCandidate[], saves: 0, inspections: 0, failSave: false, errors: [] as unknown[] };
  const repository: ImportRepository = {
    async inspect(tenant, account) {
      assert.equal(tenant, tenantId);
      assert.equal(account, accountId);
      state.inspections++;
      return state.saved;
    },
    async withAccountLock(tenant, account, work) {
      assert.equal(tenant, tenantId);
      assert.equal(account, accountId);
      const staged: ImportCandidate[] = [];
      const result = await work({
        async findCandidates() { return state.saved; },
        async save(rows: CsvRow[]) {
          state.saves++;
          for (const row of rows) staged.push({ ...row.values!, id: randomUUID(), importKey: row.importKey, ignored: false });
          if (state.failSave) throw new Error("Falha de persistência simulada");
          return staged.map((row) => row.id);
        },
      });
      state.saved.push(...staged);
      return result;
    },
  };
  const app = Fastify();
  app.addHook("onError", async (_request, _reply, error) => { state.errors.push(error); });
  registerErrorHandler(app);
  app.register(importRoutes, { service: createImportService(repository) });
  return { app, state };
}

async function upload(csv = validCsv, fields: Record<string, string> = {}, options: { filename?: string; noFile?: boolean; twoFiles?: boolean } = {}) {
  const form = new FormData();
  // Arquivo antes dos campos: a rota não pode depender da ordem do multipart.
  if (!options.noFile) form.append("file", new Blob([csv], { type: "text/csv" }), options.filename ?? "extrato.csv");
  if (options.twoFiles) form.append("file", new Blob([csv]), "outro.csv");
  form.append("accountId", accountId);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const request = new Request("http://local", { method: "POST", body: form });
  return { headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) };
}

test("preview não grava; commit salva e repetir o lote retorna 409", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  const preview = await app.inject({ method: "POST", url: "/imports/csv/preview", ...await upload() });
  assert.equal(preview.statusCode, 200, preview.body);
  const body = preview.json<CsvPreview>();
  assert.equal(body.canImport, true);
  assert.equal(body.summary.validRows, 1);
  assert.equal(state.saves, 0);
  const commitInput = await upload(validCsv, { previewToken: body.previewToken });
  const commit = await app.inject({ method: "POST", url: "/imports/csv", ...commitInput });
  assert.equal(commit.statusCode, 201, commit.body);
  assert.equal(commit.json().importedCount, 1);
  assert.equal(commit.json().pendingReviewCount, 1);
  const again = await app.inject({ method: "POST", url: "/imports/csv", ...commitInput });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().error, "CSV_DUPLICATES");
  assert.equal(state.saved.length, 1);
});

test("uma linha inválida impede a gravação de todo o lote", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  const csv = `${validCsv}2026-09-99,Inválida,10,OUTFLOW,EXPENSE\n`;
  const preview = await app.inject({ method: "POST", url: "/imports/csv/preview", ...await upload(csv) });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().summary.invalidRows, 1);
  const commit = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(csv, { previewToken: preview.json().previewToken }) });
  assert.equal(commit.statusCode, 422);
  assert.equal(state.saves, 0);
  assert.equal(state.saved.length, 0);
});

test("arquivo alterado depois do preview é recusado", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  const preview = await app.inject({ method: "POST", url: "/imports/csv/preview", ...await upload() });
  const commit = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(validCsv.replace("12.34", "50.00"), { previewToken: preview.json().previewToken }) });
  assert.equal(commit.statusCode, 409);
  assert.equal(commit.json().error, "CSV_PREVIEW_CHANGED");
  assert.equal(state.saves, 0);
});

test("possíveis duplicatas só passam com confirmação explícita; false não vira true", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  const csv = `${validCsv}2026-09-01,Mercado,12.34,OUTFLOW,EXPENSE\n`;
  const preview = await app.inject({ method: "POST", url: "/imports/csv/preview", ...await upload(csv) });
  const previewToken = preview.json().previewToken;
  const refused = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(csv, { previewToken, allowPossibleDuplicates: "false" }) });
  assert.equal(refused.statusCode, 409);
  const accepted = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(csv, { previewToken, allowPossibleDuplicates: "true" }) });
  assert.equal(accepted.statusCode, 201, accepted.body);
  assert.equal(state.saved.length, 2);
  const repeated = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(csv, { previewToken, allowPossibleDuplicates: "true" }) });
  assert.equal(repeated.statusCode, 409);
});

test("falha de persistência não retorna sucesso nem expõe detalhes internos", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  state.failSave = true;
  const preview = await app.inject({ method: "POST", url: "/imports/csv/preview", ...await upload() });
  const commit = await app.inject({ method: "POST", url: "/imports/csv", ...await upload(validCsv, { previewToken: preview.json().previewToken }) });
  assert.equal(commit.statusCode, 500);
  assert.equal(commit.json().error, "INTERNAL_SERVER_ERROR");
  assert.ok(!commit.body.includes("simulada"));
  assert.equal(state.saved.length, 0);
});

test("valida o contrato multipart, tamanho, quantidade de arquivos e confirmação", async (t) => {
  const { app, state } = setup();
  t.after(() => app.close());
  const cases = [
    { url: "/imports/csv/preview", request: { payload: {} }, status: 415 },
    { url: "/imports/csv/preview", request: await upload(validCsv, {}, { noFile: true }), status: 400 },
    { url: "/imports/csv/preview", request: await upload(validCsv, {}, { filename: "arquivo.txt" }), status: 400 },
    { url: "/imports/csv/preview", request: await upload(validCsv, {}, { twoFiles: true }), status: 413 },
    { url: "/imports/csv/preview", request: await upload("a".repeat(CSV_MAX_BYTES + 1)), status: 413 },
    { url: "/imports/csv/preview", request: await upload(validCsv, { allowPossibleDuplicates: "yes" }), status: 400 },
    { url: "/imports/csv/preview", request: await upload(validCsv, { tenantId: randomUUID() }), status: 400 },
    { url: "/imports/csv/preview", request: await upload(validCsv, { accountId: randomUUID() }), status: 400 },
    { url: "/imports/csv", request: await upload(), status: 400 },
    { url: "/imports/csv", request: await upload(validCsv, { previewToken: "invalid" }), status: 400 },
  ];
  for (const entry of cases) {
    const result = await app.inject({ method: "POST", url: entry.url, ...entry.request });
    assert.equal(result.statusCode, entry.status, `Caso ${cases.indexOf(entry)}: ${result.body} / ${String(state.errors.at(-1))}`);
  }
});
