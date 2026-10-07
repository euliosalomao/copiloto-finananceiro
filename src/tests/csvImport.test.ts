import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPreview, CSV_MAX_BYTES, CSV_MAX_ROWS, CsvImportError, parseCsv, requireImportable,
  type ImportCandidate,
} from "../core/csvImport.js";

const accountId = "75648088-05ee-40b5-b837-8726df9d0b92";
const tenantId = "5a172f1c-d031-4ee6-9341-170bab71bfae";
const header = "transactionDate,description,amount,direction,operationType";
const row = "2026-09-01,Mercado,12.34,OUTFLOW,EXPENSE";
const csv = (body = row, columns = header) => Buffer.from(`${columns}\n${body}\n`);
const isCode = (code: string) => (error: unknown) => error instanceof CsvImportError && error.code === code;

test("normaliza valores sem ponto flutuante e preserva os dados originais", () => {
  const parsed = parseCsv(csv("2026-09-01, Mercado ,00012.3,OUTFLOW,EXPENSE"), accountId);
  assert.equal(parsed.rows[0]?.values?.amount, "12.30");
  assert.equal(parsed.rows[0]?.values?.description, "Mercado");
  assert.equal(parsed.rows[0]?.line, 2);
  assert.equal(parsed.rows[0]?.rowNumber, 1);
  assert.equal(parsed.rows[0]?.raw[2], "00012.3");
  assert.equal(parseCsv(csv(row.replace("12.34", "999999999999.99")), accountId).rows[0]?.values?.amount, "999999999999.99");
});

test("aceita UTF-8 com BOM, ponto e vírgula, decimal brasileiro e aspas", () => {
  const parsed = parseCsv(Buffer.from('\uFEFFtransactionDate;description;amount;direction;operationType;notes\r\n2026-09-01;"Loja; centro";12,34;OUTFLOW;EXPENSE;"Linha 1\nLinha 2"\r\n'), accountId);
  assert.equal(parsed.delimiter, ";");
  assert.equal(parsed.rows[0]?.values?.amount, "12.34");
  assert.equal(parsed.rows[0]?.values?.description, "Loja; centro");
  assert.equal(parsed.rows[0]?.values?.notes, "Linha 1\nLinha 2");
  assert.equal(parsed.rows[0]?.line, 3);
});

test("aceita vírgulas e aspas escapadas dentro de um campo", () => {
  const parsed = parseCsv(csv('2026-09-01,"Loja, ""Centro""",12,OUTFLOW,EXPENSE'), accountId);
  assert.equal(parsed.rows[0]?.values?.description, 'Loja, "Centro"');
});

test("preview informa erros por linha, sem descartar a parte válida", () => {
  const parsed = parseCsv(csv([
    row, "2026-02-30,Mercado,12,OUTFLOW,EXPENSE",
    "2026-09-01,,12,OUTFLOW,EXPENSE", "2026-09-01,Mercado,-12,OUTFLOW,EXPENSE",
    "2026-09-01,Mercado,12,INFLOW,EXPENSE", "2026-09-01,Mercado,12",
  ].join("\n")), accountId);
  const result = buildPreview(parsed, tenantId, accountId, []);
  assert.deepEqual(result.summary, { totalRows: 6, validRows: 1, invalidRows: 5, duplicateRows: 0, possibleDuplicateRows: 0 });
  assert.equal(result.rows[1]?.errors[0]?.field, "transactionDate");
  assert.equal(result.rows[1]?.raw[0], "2026-02-30");
  assert.equal(result.canImport, false);
  assert.throws(() => requireImportable(result), isCode("CSV_INVALID_ROWS"));
});

for (const amount of ["1.234,56", "1,234.56", "1e3", "NaN", "Infinity", "12.345", "1000000000000", "R$12", "-1", "+1"]) {
  test(`rejeita valor ambíguo ou fora do limite: ${amount}`, () => {
    assert.equal(parseCsv(csv(`2026-09-01,Loja,"${amount}",OUTFLOW,EXPENSE`), accountId).rows[0]?.values, null);
  });
}

test("rejeita arquivos vazios, cabeçalhos inesperados, encoding e aspas inválidos", () => {
  assert.throws(() => parseCsv(Buffer.alloc(0), accountId), isCode("CSV_EMPTY"));
  assert.throws(() => parseCsv(csv(""), accountId), isCode("CSV_EMPTY"));
  assert.throws(() => parseCsv(csv(row, "date,description,amount,direction,operationType"), accountId), isCode("CSV_HEADERS"));
  assert.throws(() => parseCsv(csv(`${row},extra`, `${header},tenantId`), accountId), isCode("CSV_HEADERS"));
  assert.throws(() => parseCsv(csv(`${row},extra`, `${header},amount`), accountId), isCode("CSV_HEADERS"));
  assert.throws(() => parseCsv(Buffer.from([0xff]), accountId), isCode("CSV_ENCODING"));
  assert.throws(() => parseCsv(csv('2026-09-01,"aspas abertas,12,OUTFLOW,EXPENSE'), accountId), isCode("CSV_MALFORMED"));
});

test("limita bytes, tamanho do registro e número de transações", () => {
  assert.throws(() => parseCsv(Buffer.alloc(CSV_MAX_BYTES + 1), accountId), isCode("CSV_TOO_LARGE"));
  assert.throws(() => parseCsv(csv(Array(CSV_MAX_ROWS + 1).fill(row).join("\n")), accountId), isCode("CSV_TOO_MANY_ROWS"));
  assert.equal(parseCsv(csv(Array(CSV_MAX_ROWS).fill(row).join("\n")), accountId).rows.length, CSV_MAX_ROWS);
  assert.throws(() => parseCsv(csv(`2026-09-01,${"a".repeat(70_000)},12,OUTFLOW,EXPENSE`), accountId), isCode("CSV_MALFORMED"));
});

test("identidade estável por arquivo/posição, ou por externalId quando disponível", () => {
  const original = parseCsv(csv(), accountId);
  assert.equal(original.rows[0]?.importKey, parseCsv(csv(), accountId).rows[0]?.importKey);
  assert.equal(original.rows[0]?.importKey, parseCsv(csv(), accountId.toUpperCase()).rows[0]?.importKey);
  assert.notEqual(original.rows[0]?.importKey, parseCsv(csv(), "outra-conta").rows[0]?.importKey);
  assert.notEqual(original.rows[0]?.importKey, parseCsv(csv(`${row}\n${row}`), accountId).rows[0]?.importKey);
  const external = parseCsv(csv(`${row},banco-1`, `${header},externalId`), accountId);
  const changed = parseCsv(csv(`${row.replace("Mercado", "Descrição corrigida")},banco-1`, `${header},externalId`), accountId);
  assert.equal(external.rows[0]?.importKey, changed.rows[0]?.importKey);
});

test("preview rejeita ano zero e caracteres que o PostgreSQL não aceita", () => {
  assert.equal(parseCsv(csv(row.replace("2026-09-01", "0000-09-01")), accountId).rows[0]?.values, null);
  assert.equal(parseCsv(csv(row.replace("Mercado", "Mer\0cado")), accountId).rows[0]?.values, null);
  assert.equal(parseCsv(csv(`${row},nota\0inválida`, `${header},notes`), accountId).rows[0]?.values, null);
});

test("distingue compras parecidas de IDs repetidos no arquivo", () => {
  const possible = buildPreview(parseCsv(csv(`${row}\n${row}`), accountId), tenantId, accountId, []);
  assert.equal(possible.summary.possibleDuplicateRows, 1);
  assert.equal(possible.canImport, false);
  assert.equal(buildPreview(parseCsv(csv(`${row}\n${row}`), accountId), tenantId, accountId, [], true).canImport, true);
  const certain = buildPreview(parseCsv(csv(`${row},id-1\n${row},id-1`, `${header},externalId`), accountId), tenantId, accountId, [], true);
  assert.equal(certain.summary.duplicateRows, 1);
  assert.equal(certain.canImport, false);
});

test("banco: duplicata certa bloqueia mesmo excluída; semelhança exige confirmação", () => {
  const parsed = parseCsv(csv(), accountId);
  const candidate: ImportCandidate = { ...parsed.rows[0]!.values!, id: "existing", importKey: parsed.rows[0]!.importKey, ignored: true };
  const certain = buildPreview(parsed, tenantId, accountId, [candidate], true);
  assert.equal(certain.summary.duplicateRows, 1);
  assert.equal(certain.rows[0]?.duplicates[0]?.ignored, true);
  assert.equal(certain.canImport, false);
  const similar = { ...candidate, importKey: null, description: "  MERCADO  " };
  const possible = buildPreview(parsed, tenantId, accountId, [similar]);
  assert.equal(possible.summary.possibleDuplicateRows, 1);
  assert.equal(possible.canImport, false);
  assert.equal(buildPreview(parsed, tenantId, accountId, [similar], true).canImport, true);
});
