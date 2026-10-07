import { calculateFileHash, fingerprintStatementTransactions } from "../core/importFingerprint.js";
import type { ClassificationResult } from "../core/schemas/types.js";
import type { ImportBatchesRepository } from "../data/importBatchesRepository.js";
import type { StatementImportRepository } from "../data/statementImportRepository.js";
import type {
  BankStatementFormat,
  BankStatementParserRegistry,
} from "../integrations/bankStatements/index.js";

export type StatementImportInput = {
  accountId: string;
  format: BankStatementFormat;
  source: "MANUAL" | "GMAIL" | "N8N";
  sourceMessageId?: string | null;
  sourceAttachmentId?: string | null;
  file: Buffer;
  fileName: string;
  mimeType?: string;
};

export class StatementImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "StatementImportError";
  }
}

type ClassifyTransaction = (
  tenantId: string,
  transactionId: string,
) => Promise<ClassificationResult>;

export type StatementImportDependencies = {
  parserRegistry: Pick<BankStatementParserRegistry, "get" | "parse">;
  batches: ImportBatchesRepository;
  repository: StatementImportRepository;
  classifyTransaction: ClassifyTransaction;
};

function expectedImportError(error: unknown): StatementImportError | null {
  if (error instanceof StatementImportError) return error;

  const code = error instanceof Error && "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
  if (!code ||
    (!code.startsWith("INTER_CSV_") &&
      !code.startsWith("BANK_STATEMENT_"))) {
    return null;
  }
  const message = error instanceof Error
    ? error.message
    : "Não foi possível importar o extrato.";
  const statusCode = code.includes("TOO_LARGE")
    ? 413
    : code.startsWith("INTER_CSV_") || code.startsWith("BANK_STATEMENT_")
      ? 422
      : 500;

  return new StatementImportError(code, message, statusCode);
}

function failureIdentity(error: unknown) {
  const normalized = expectedImportError(error);
  return {
    errorCode: normalized?.code ??
      (error instanceof Error ? error.name : "UNKNOWN_ERROR"),
    errorMessage: normalized?.message ??
      "Falha interna durante a importação do extrato.",
  };
}

async function classifyImported(
  tenantId: string,
  transactionIds: readonly string[],
  classifyTransaction: ClassifyTransaction,
) {
  let cursor = 0;
  const results: ClassificationResult[] = [];
  const failedTransactionIds: string[] = [];

  // Evita centenas de consultas simultâneas sem transformar o request em um
  // processamento estritamente sequencial.
  const workers = Array.from(
    { length: Math.min(8, transactionIds.length) },
    async () => {
      while (cursor < transactionIds.length) {
        const index = cursor++;
        const transactionId = transactionIds[index]!;
        try {
          results.push(await classifyTransaction(tenantId, transactionId));
        } catch {
          failedTransactionIds.push(transactionId);
        }
      }
    },
  );
  await Promise.all(workers);

  return {
    classifiedCount: results.filter((result) => result.status === "CLASSIFIED").length,
    pendingReviewCount: results.filter((result) => result.status === "PENDING_REVIEW").length,
    classificationFailedCount: failedTransactionIds.length,
    failedTransactionIds,
  };
}

export function createStatementImportService(
  dependencies: StatementImportDependencies,
) {
  return {
    async import(tenantId: string, input: StatementImportInput) {
      const parser = dependencies.parserRegistry.get(input.format);
      await dependencies.repository.assertAccountAvailable(
        tenantId,
        input.accountId,
      );

      const claim = await dependencies.batches.claim({
        tenantId,
        accountId: input.accountId,
        provider: parser.provider,
        format: input.format,
        source: input.source,
        sourceMessageId: input.sourceMessageId,
        sourceAttachmentId: input.sourceAttachmentId,
        fileHash: calculateFileHash(input.file),
        metadata: {
          fileName: input.fileName,
          mimeType: input.mimeType ?? null,
        },
      });

      if (claim.kind !== "CREATED") {
        throw new StatementImportError(
          claim.kind,
          claim.kind === "SOURCE_CONFLICT"
            ? "A mesma origem já foi usada com outro arquivo ou conta."
            : "Este extrato já foi recebido anteriormente.",
          409,
          {
            batchId: claim.batch.id,
            batchStatus: claim.batch.status,
          },
        );
      }

      let statement;
      let persisted;
      try {
        statement = dependencies.parserRegistry.parse(input.format, {
          file: input.file,
          fileName: input.fileName,
          mimeType: input.mimeType,
        });
        const fingerprints = fingerprintStatementTransactions(
          statement.provider,
          input.accountId,
          statement.transactions,
        );
        persisted = await dependencies.repository.persist({
          tenantId,
          accountId: input.accountId,
          statement,
          transactions: statement.transactions.map((transaction, index) => ({
            transaction,
            identityKey: fingerprints[index]!.identityKey,
          })),
        });
      } catch (error) {
        const failure = failureIdentity(error);
        await dependencies.batches.markFailed({
          tenantId,
          batchId: claim.batch.id,
          totalTransactions: statement?.transactions.length ?? 0,
          failedCount: statement?.transactions.length ?? 0,
          ...failure,
        });
        const expected = expectedImportError(error);
        if (expected) throw expected;
        throw error;
      }

      const classification = await classifyImported(
        tenantId,
        persisted.transactionIds,
        dependencies.classifyTransaction,
      );
      const finishInput = {
        tenantId,
        batchId: claim.batch.id,
        totalTransactions: statement.transactions.length,
        importedCount: persisted.transactionIds.length,
        duplicateCount: persisted.duplicateCount,
        possibleDuplicateCount: 0,
        failedCount: classification.classificationFailedCount,
      };
      const batch = classification.classificationFailedCount > 0
        ? await dependencies.batches.markNeedsReview(finishInput)
        : await dependencies.batches.markImported(finishInput);

      if (!batch) {
        throw new StatementImportError(
          "IMPORT_BATCH_ALREADY_FINISHED",
          "O lote de importação já havia sido finalizado.",
          409,
          { batchId: claim.batch.id },
        );
      }

      return {
        batchId: batch.id,
        batchStatus: batch.status,
        format: statement.format,
        provider: statement.provider,
        totalTransactions: statement.transactions.length,
        importedCount: persisted.transactionIds.length,
        duplicateCount: persisted.duplicateCount,
        transactionIds: persisted.transactionIds,
        issues: statement.issues,
        ...classification,
      };
    },
  };
}

export type StatementImportService = ReturnType<typeof createStatementImportService>;
