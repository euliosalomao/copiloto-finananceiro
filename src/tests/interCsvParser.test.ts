import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bankStatementParserRegistry } from "../integrations/bankStatements/index.js";
import {
  INTER_CSV_MAX_BYTES,
  InterCsvParser,
  InterCsvParserError,
} from "../integrations/bankStatements/inter/interCsvParser.js";

const fixturePath = fileURLToPath(new URL(
  "./fixtures/bank-statements/inter-checking-anonymized.csv",
  import.meta.url,
));
const fixture = readFileSync(fixturePath);
const parser = new InterCsvParser();

function input(file: Buffer = fixture) {
  return {
    file,
    fileName: "extrato-inter.csv",
    mimeType: "text/csv",
  };
}

function hasCode(code: InterCsvParserError["code"]) {
  return (error: unknown) =>
    error instanceof InterCsvParserError && error.code === code;
}

test("reconhece o CSV do Inter e normaliza metadados e transações", () => {
  assert.equal(parser.canParse(input()), true);

  const result = parser.parse(input());
  assert.equal(result.provider, "INTER");
  assert.equal(result.format, "INTER_CSV");
  assert.deepEqual(result.metadata, {
    externalAccountReference: "000000000",
    periodStart: "2026-01-01",
    periodEnd: "2026-09-01",
    closingBalance: "1234.56",
  });
  assert.equal(result.transactions.length, 7);

  assert.deepEqual(
    {
      date: result.transactions[0]?.transactionDate,
      amount: result.transactions[0]?.amount,
      direction: result.transactions[0]?.direction,
      sourceType: result.transactions[0]?.sourceType,
      hint: result.transactions[0]?.operationTypeHint,
    },
    {
      date: "2026-09-01",
      amount: "250.00",
      direction: "INFLOW",
      sourceType: "Pix recebido",
      hint: null,
    },
  );

  const debitPurchase = result.transactions[2]!;
  assert.equal(debitPurchase.amount, "25.90");
  assert.equal(debitPurchase.direction, "OUTFLOW");
  assert.equal(debitPurchase.operationTypeHint, "EXPENSE");
  assert.equal(debitPurchase.balanceAfter, "1034.56");
});

test("normaliza espaços, preserva o raw e usa fallback para descrição vazia", () => {
  const result = parser.parse(input());
  const sentPix = result.transactions[1]!;
  assert.equal(sentPix.sourceType, "Pix enviado");
  assert.equal(sentPix.raw.Histórico, "Pix enviado ");

  const missingDescription = result.transactions[4]!;
  assert.equal(missingDescription.description, "Compra no débito");
  assert.equal(missingDescription.raw.Descrição, "");
  assert.deepEqual(result.issues, [{
    severity: "WARNING",
    code: "INTER_CSV_DESCRIPTION_FALLBACK",
    message: "Descrição vazia; o histórico foi usado como fallback.",
    rowNumber: 11,
    field: "Descrição",
  }]);
});

test("mantém duas movimentações idênticas como transações distintas", () => {
  const result = parser.parse(input());
  const repeated = result.transactions.filter(
    (transaction) => transaction.description === "COMPRA REPETIDA",
  );

  assert.equal(repeated.length, 2);
  assert.notEqual(repeated[0]?.balanceAfter, repeated[1]?.balanceAfter);
  assert.equal(repeated[0]?.externalId, null);
  assert.equal(repeated[1]?.externalId, null);
});

test("aceita BOM, CRLF e campo entre aspas contendo ponto e vírgula", () => {
  const changed = fixture
    .toString("utf8")
    .replace("MERCADO EXEMPLO", '"MERCADO; EXEMPLO"')
    .replace(/\n/g, "\r\n");
  const result = parser.parse(input(Buffer.from(`\uFEFF${changed}`)));

  assert.equal(result.transactions[2]?.description, "MERCADO; EXEMPLO");
});

test("o registro padrão expõe o parser do Inter", () => {
  const result = bankStatementParserRegistry.parse("INTER_CSV", input());
  assert.equal(result.transactions.length, 7);
});

test("recusa arquivo vazio, encoding inválido e assinatura de outro formato", () => {
  assert.equal(parser.canParse(input(Buffer.from("outro csv"))), false);
  assert.throws(
    () => parser.parse(input(Buffer.alloc(0))),
    hasCode("INTER_CSV_EMPTY"),
  );
  assert.throws(
    () => parser.parse(input(Buffer.from([0xff]))),
    hasCode("INTER_CSV_ENCODING"),
  );
  assert.throws(
    () => parser.parse(input(Buffer.from("outro csv"))),
    hasCode("INTER_CSV_SIGNATURE"),
  );
});

test("recusa arquivo acima do limite", () => {
  assert.throws(
    () => parser.parse(input(Buffer.alloc(INTER_CSV_MAX_BYTES + 1))),
    hasCode("INTER_CSV_TOO_LARGE"),
  );
});

test("recusa metadados, datas e valores inválidos", () => {
  const text = fixture.toString("utf8");
  const cases = [
    {
      csv: text.replace("Conta ;000000000", "Conta ;"),
      code: "INTER_CSV_METADATA" as const,
    },
    {
      csv: text.replace("01/09/2026;Pix recebido", "31/02/2026;Pix recebido"),
      code: "INTER_CSV_INVALID_ROW" as const,
    },
    {
      csv: text.replace("250,00;1.234,56", "1,2;1.234,56"),
      code: "INTER_CSV_INVALID_ROW" as const,
    },
    {
      csv: text.replace("250,00;1.234,56", "0,00;1.234,56"),
      code: "INTER_CSV_INVALID_ROW" as const,
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => parser.parse(input(Buffer.from(entry.csv))),
      hasCode(entry.code),
    );
  }
});

test("recusa mudança de cabeçalho e ordem", () => {
  const text = fixture.toString("utf8");
  const cases = [
    {
      csv: text.replace("Data Lançamento", "Data"),
      code: "INTER_CSV_SIGNATURE" as const,
    },
    {
      csv: text.replace(
        "30/08/2026;Pagamento efetuado",
        "01/09/2026;Pagamento efetuado",
      ),
      code: "INTER_CSV_INVALID_ORDER" as const,
    },
  ];

  for (const entry of cases) {
    assert.throws(
      () => parser.parse(input(Buffer.from(entry.csv))),
      hasCode(entry.code),
    );
  }
});

test("saldo divergente gera warning auditável sem bloquear o extrato", () => {
  const text = fixture.toString("utf8");

  const transition = parser.parse(input(Buffer.from(
    text.replace("984,56", "984,55"),
  )));
  const transitionWarnings = transition.issues.filter((issue) =>
    issue.code === "INTER_CSV_BALANCE_MISMATCH"
  );
  assert.equal(transitionWarnings.length, 2);
  assert.deepEqual(
    transitionWarnings.find((issue) => issue.rowNumber === 8),
    {
      severity: "WARNING",
      code: "INTER_CSV_BALANCE_MISMATCH",
      message:
        "Saldo entre transações não reconciliado: esperado 984.56, encontrado 984.55.",
      rowNumber: 8,
      field: "Saldo",
    },
  );

  const header = parser.parse(input(Buffer.from(
    text.replace("Saldo ;1.234,56", "Saldo ;1.234,55"),
  )));
  assert.deepEqual(
    header.issues.filter((issue) =>
      issue.code === "INTER_CSV_BALANCE_MISMATCH"
    ),
    [{
      severity: "WARNING",
      code: "INTER_CSV_BALANCE_MISMATCH",
      message:
        "Saldo do cabeçalho não coincide com a transação mais recente: cabeçalho 1234.55, transação 1234.56.",
      rowNumber: 7,
      field: "Saldo",
    }],
  );
});
