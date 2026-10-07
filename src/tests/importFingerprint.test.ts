import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateFileHash,
  fingerprintStatementTransactions,
} from "../core/importFingerprint.js";
import type { NormalizedStatementTransaction } from "../integrations/bankStatements/types.js";

function transaction(
  overrides: Partial<NormalizedStatementTransaction> = {},
): NormalizedStatementTransaction {
  return {
    rowNumber: 7,
    transactionDate: "2026-09-01",
    description: "Mercado Exemplo",
    amount: "25.90",
    direction: "OUTFLOW",
    operationTypeHint: "EXPENSE",
    externalId: null,
    balanceAfter: "100.00",
    sourceType: "Compra no débito",
    raw: {},
    ...overrides,
  };
}

test("hash do arquivo é SHA-256 estável e sensível aos bytes", () => {
  assert.equal(calculateFileHash(Buffer.from("csv")), calculateFileHash(Buffer.from("csv")));
  assert.notEqual(calculateFileHash(Buffer.from("csv")), calculateFileHash(Buffer.from("CSV")));
  assert.match(calculateFileHash(Buffer.from("csv")), /^[0-9a-f]{64}$/);
});

test("fingerprint isola conta e provider, mas ignora enriquecimento mutável", () => {
  const base = fingerprintStatementTransactions("INTER", "account-1", [transaction()])[0]!;
  const enriched = fingerprintStatementTransactions("INTER", "account-1", [transaction({
    operationTypeHint: "TRANSFER",
    balanceAfter: "999.00",
    raw: { extra: "novo" },
  })])[0]!;

  assert.equal(base.identityKey, enriched.identityKey);
  assert.equal(base.contentHash, enriched.contentHash);
  assert.notEqual(
    base.identityKey,
    fingerprintStatementTransactions("BRADESCO", "account-1", [transaction()])[0]?.identityKey,
  );
  assert.notEqual(
    base.identityKey,
    fingerprintStatementTransactions("INTER", "account-2", [transaction()])[0]?.identityKey,
  );
});

test("movimentos iguais recebem ocorrências distintas e repetíveis", () => {
  const first = fingerprintStatementTransactions("INTER", "account-1", [
    transaction(),
    transaction({ rowNumber: 8, balanceAfter: "125.90" }),
  ]);
  const second = fingerprintStatementTransactions("INTER", "account-1", [
    transaction(),
    transaction({ rowNumber: 99, balanceAfter: "500.00" }),
  ]);

  assert.deepEqual(first.map((item) => item.occurrence), [1, 2]);
  assert.notEqual(first[0]?.identityKey, first[1]?.identityKey);
  assert.deepEqual(
    first.map((item) => item.identityKey),
    second.map((item) => item.identityKey),
  );
  assert.equal(first[0]?.contentHash, first[1]?.contentHash);
});

test("ID externo é identidade forte mesmo se a descrição mudar", () => {
  const original = fingerprintStatementTransactions("INTER", "account-1", [
    transaction({ externalId: "bank-123" }),
  ])[0]!;
  const changed = fingerprintStatementTransactions("INTER", "account-1", [
    transaction({ externalId: "bank-123", description: "Descrição corrigida" }),
  ])[0]!;

  assert.equal(original.strength, "PROVIDER_ID");
  assert.equal(original.identityKey, changed.identityKey);
});
