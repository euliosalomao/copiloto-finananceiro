import assert from "node:assert/strict";
import test from "node:test";
import {
  BankStatementParserRegistry,
  BankStatementParserRegistryError,
} from "../integrations/bankStatements/parserRegistry.js";
import type {
  BankStatementParseInput,
  BankStatementParser,
  ParsedBankStatement,
} from "../integrations/bankStatements/types.js";

const input: BankStatementParseInput = {
  file: Buffer.from("arquivo de teste"),
  fileName: "extrato.csv",
  mimeType: "text/csv",
};

const parsed: ParsedBankStatement = {
  provider: "TEST_BANK",
  format: "INTER_CSV",
  metadata: {
    externalAccountReference: null,
    periodStart: "2026-01-01",
    periodEnd: "2026-09-01",
    closingBalance: "1234.56",
  },
  transactions: [],
  issues: [],
};

function fakeParser(canParse = true): BankStatementParser {
  return {
    provider: "TEST_BANK",
    format: "INTER_CSV",
    canParse: () => canParse,
    parse(received) {
      assert.equal(received, input);
      return parsed;
    },
  };
}

function hasCode(code: BankStatementParserRegistryError["code"]) {
  return (error: unknown) =>
    error instanceof BankStatementParserRegistryError &&
    error.code === code;
}

test("registra um parser e delega a leitura pelo formato explicito", () => {
  const parser = fakeParser();
  const registry = new BankStatementParserRegistry([parser]);

  assert.equal(registry.get("INTER_CSV"), parser);
  assert.equal(registry.parse("INTER_CSV", input), parsed);
});

test("recusa dois parsers para o mesmo formato", () => {
  assert.throws(
    () => new BankStatementParserRegistry([fakeParser(), fakeParser()]),
    hasCode("DUPLICATE_BANK_STATEMENT_PARSER"),
  );
});

test("distingue formato sem parser de arquivo com assinatura errada", () => {
  const empty = new BankStatementParserRegistry([]);
  assert.throws(
    () => empty.get("INTER_CSV"),
    hasCode("BANK_STATEMENT_FORMAT_UNSUPPORTED"),
  );

  const registry = new BankStatementParserRegistry([fakeParser(false)]);
  assert.throws(
    () => registry.parse("INTER_CSV", input),
    hasCode("BANK_STATEMENT_FORMAT_MISMATCH"),
  );
});
