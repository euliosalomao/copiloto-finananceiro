import { createHash } from "node:crypto";
import type { NormalizedStatementTransaction } from "../integrations/bankStatements/types.js";

export type TransactionFingerprint = {
  identityKey: string;
  contentHash: string;
  occurrence: number;
  strength: "PROVIDER_ID" | "CONTENT_OCCURRENCE";
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string | null): string {
  return (value ?? "")
    .normalize("NFC")
    .trim()
    .replace(/\s+/g, " ")
    .toUpperCase();
}

export function calculateFileHash(file: Buffer): string {
  return sha256(file);
}

export function fingerprintStatementTransactions(
  provider: string,
  accountId: string,
  transactions: readonly NormalizedStatementTransaction[],
): TransactionFingerprint[] {
  const normalizedProvider = provider.trim().toUpperCase();
  const normalizedAccountId = accountId.trim().toLowerCase();
  const occurrences = new Map<string, number>();

  return transactions.map((transaction) => {
    const externalId = transaction.externalId?.trim();
    if (externalId) {
      const contentHash = sha256(JSON.stringify([
        "bank-transaction-external-v1",
        normalizedProvider,
        normalizedAccountId,
        externalId,
      ]));
      return {
        identityKey: `bank-tx:v1:${contentHash}`,
        contentHash,
        occurrence: 1,
        strength: "PROVIDER_ID" as const,
      };
    }

    // operationTypeHint, saldo e raw ficam de fora: classificação, correções
    // de saldo ou enriquecimento futuro não podem mudar a identidade base.
    const contentHash = sha256(JSON.stringify([
      "bank-transaction-content-v1",
      normalizedProvider,
      normalizedAccountId,
      transaction.transactionDate,
      normalizeText(transaction.description),
      transaction.amount,
      transaction.direction,
      normalizeText(transaction.sourceType),
    ]));
    const occurrence = (occurrences.get(contentHash) ?? 0) + 1;
    occurrences.set(contentHash, occurrence);

    const identityHash = sha256(JSON.stringify([
      "bank-transaction-occurrence-v1",
      contentHash,
      occurrence,
    ]));

    return {
      identityKey: `bank-tx:v1:${identityHash}`,
      contentHash,
      occurrence,
      strength: "CONTENT_OCCURRENCE" as const,
    };
  });
}
