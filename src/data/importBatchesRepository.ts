import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

const batchSelect = {
  id: true,
  tenant_id: true,
  account_id: true,
  provider: true,
  format: true,
  source: true,
  source_message_id: true,
  source_attachment_id: true,
  file_hash: true,
  status: true,
  total_transactions: true,
  imported_count: true,
  duplicate_count: true,
  possible_duplicate_count: true,
  failed_count: true,
  error_code: true,
  error_message: true,
  metadata: true,
  started_at: true,
  finished_at: true,
  created_at: true,
  updated_at: true,
} satisfies Prisma.import_batchesSelect;

export type ImportBatch = Prisma.import_batchesGetPayload<{
  select: typeof batchSelect;
}>;

export type ClaimImportBatchInput = {
  tenantId: string;
  accountId: string;
  provider: string;
  format: string;
  source: string;
  sourceMessageId?: string | null;
  sourceAttachmentId?: string | null;
  fileHash: string;
  metadata?: Prisma.InputJsonValue;
};

export type ClaimImportBatchResult =
  | { kind: "CREATED"; batch: ImportBatch }
  | { kind: "SOURCE_DUPLICATE"; batch: ImportBatch }
  | { kind: "FILE_DUPLICATE"; batch: ImportBatch }
  | { kind: "SOURCE_CONFLICT"; batch: ImportBatch };

export type FinishImportBatchInput = {
  tenantId: string;
  batchId: string;
  totalTransactions: number;
  importedCount: number;
  duplicateCount: number;
  possibleDuplicateCount: number;
  failedCount: number;
};

export type ImportBatchesRepository = {
  claim(input: ClaimImportBatchInput): Promise<ClaimImportBatchResult>;
  markImported(input: FinishImportBatchInput): Promise<ImportBatch | null>;
  markNeedsReview(input: FinishImportBatchInput): Promise<ImportBatch | null>;
  markFailed(input: {
    tenantId: string;
    batchId: string;
    totalTransactions?: number;
    failedCount: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<ImportBatch | null>;
  findById(tenantId: string, batchId: string): Promise<ImportBatch | null>;
};

function optionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedClaim(input: ClaimImportBatchInput) {
  const claim = {
    ...input,
    provider: input.provider.trim().toUpperCase(),
    format: input.format.trim().toUpperCase(),
    source: input.source.trim().toUpperCase(),
    sourceMessageId: optionalText(input.sourceMessageId),
    sourceAttachmentId: optionalText(input.sourceAttachmentId),
    fileHash: input.fileHash.trim().toLowerCase(),
  };

  if (!claim.provider || !claim.format || !claim.source) {
    throw new Error("Provider, format e source são obrigatórios.");
  }
  if (!/^[0-9a-f]{64}$/.test(claim.fileHash)) {
    throw new Error("fileHash precisa ser um SHA-256 hexadecimal.");
  }
  if (claim.sourceAttachmentId && !claim.sourceMessageId) {
    throw new Error("sourceAttachmentId exige sourceMessageId.");
  }

  return claim;
}

async function findBySource(
  input: ReturnType<typeof normalizedClaim>,
): Promise<ImportBatch | null> {
  if (!input.sourceMessageId) return null;

  return prisma.import_batches.findFirst({
    where: {
      tenant_id: input.tenantId,
      source: input.source,
      source_message_id: input.sourceMessageId,
      source_attachment_id: input.sourceAttachmentId,
    },
    select: batchSelect,
  });
}

async function findByFile(
  input: ReturnType<typeof normalizedClaim>,
): Promise<ImportBatch | null> {
  return prisma.import_batches.findFirst({
    where: {
      tenant_id: input.tenantId,
      account_id: input.accountId,
      provider: input.provider,
      format: input.format,
      file_hash: input.fileHash,
    },
    select: batchSelect,
  });
}

function sameSourcePayload(
  batch: ImportBatch,
  input: ReturnType<typeof normalizedClaim>,
): boolean {
  return batch.account_id === input.accountId &&
    batch.provider === input.provider &&
    batch.format === input.format &&
    batch.file_hash === input.fileHash;
}

async function resolveExisting(
  input: ReturnType<typeof normalizedClaim>,
): Promise<Exclude<ClaimImportBatchResult, { kind: "CREATED" }> | null> {
  const sourceBatch = await findBySource(input);
  if (sourceBatch) {
    return sameSourcePayload(sourceBatch, input)
      ? { kind: "SOURCE_DUPLICATE", batch: sourceBatch }
      : { kind: "SOURCE_CONFLICT", batch: sourceBatch };
  }

  const fileBatch = await findByFile(input);
  return fileBatch ? { kind: "FILE_DUPLICATE", batch: fileBatch } : null;
}

async function reopenFailedBatch(
  input: ReturnType<typeof normalizedClaim>,
  existing: Exclude<ClaimImportBatchResult, { kind: "CREATED" }>,
): Promise<ImportBatch | null> {
  if (existing.kind === "SOURCE_CONFLICT" || existing.batch.status !== "FAILED") {
    return null;
  }

  const startedAt = new Date();
  const reopened = await prisma.import_batches.updateMany({
    where: {
      id: existing.batch.id,
      tenant_id: input.tenantId,
      status: "FAILED",
    },
    data: {
      account_id: input.accountId,
      provider: input.provider,
      format: input.format,
      source: input.source,
      source_message_id: input.sourceMessageId,
      source_attachment_id: input.sourceAttachmentId,
      file_hash: input.fileHash,
      metadata: input.metadata,
      status: "PROCESSING",
      total_transactions: 0,
      imported_count: 0,
      duplicate_count: 0,
      possible_duplicate_count: 0,
      failed_count: 0,
      error_code: null,
      error_message: null,
      started_at: startedAt,
      finished_at: null,
      updated_at: startedAt,
    },
  });
  if (reopened.count === 0) return null;

  return prisma.import_batches.findFirst({
    where: { id: existing.batch.id, tenant_id: input.tenantId },
    select: batchSelect,
  });
}

async function finishBatch(
  status: "IMPORTED" | "NEEDS_REVIEW",
  input: FinishImportBatchInput,
): Promise<ImportBatch | null> {
  const finishedAt = new Date();
  const updated = await prisma.import_batches.updateMany({
    where: {
      id: input.batchId,
      tenant_id: input.tenantId,
      status: "PROCESSING",
    },
    data: {
      status,
      total_transactions: input.totalTransactions,
      imported_count: input.importedCount,
      duplicate_count: input.duplicateCount,
      possible_duplicate_count: input.possibleDuplicateCount,
      failed_count: input.failedCount,
      finished_at: finishedAt,
      updated_at: finishedAt,
    },
  });
  if (updated.count === 0) return null;

  return prisma.import_batches.findFirst({
    where: { id: input.batchId, tenant_id: input.tenantId },
    select: batchSelect,
  });
}

export const importBatchesRepository: ImportBatchesRepository = {
  async claim(rawInput: ClaimImportBatchInput): Promise<ClaimImportBatchResult> {
    const input = normalizedClaim(rawInput);
    const existing = await resolveExisting(input);
    if (existing) {
      const reopened = await reopenFailedBatch(input, existing);
      if (reopened) return { kind: "CREATED", batch: reopened };

      // Se outra requisição reabriu o lote entre a leitura e o update, ela é a
      // dona do processamento; esta chamada volta como duplicata.
      return await resolveExisting(input) ?? existing;
    }

    try {
      const batch = await prisma.import_batches.create({
        data: {
          tenant_id: input.tenantId,
          account_id: input.accountId,
          provider: input.provider,
          format: input.format,
          source: input.source,
          source_message_id: input.sourceMessageId,
          source_attachment_id: input.sourceAttachmentId,
          file_hash: input.fileHash,
          status: "PROCESSING",
          metadata: input.metadata,
        },
        select: batchSelect,
      });
      return { kind: "CREATED", batch };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await resolveExisting(input);
        if (raced) return raced;
      }
      throw error;
    }
  },

  markImported(input: FinishImportBatchInput) {
    return finishBatch("IMPORTED", input);
  },

  markNeedsReview(input: FinishImportBatchInput) {
    return finishBatch("NEEDS_REVIEW", input);
  },

  async markFailed(input: {
    tenantId: string;
    batchId: string;
    totalTransactions?: number;
    failedCount: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<ImportBatch | null> {
    const finishedAt = new Date();
    const updated = await prisma.import_batches.updateMany({
      where: {
        id: input.batchId,
        tenant_id: input.tenantId,
        status: "PROCESSING",
      },
      data: {
        status: "FAILED",
        total_transactions: input.totalTransactions ?? 0,
        failed_count: input.failedCount,
        error_code: input.errorCode,
        error_message: input.errorMessage,
        finished_at: finishedAt,
        updated_at: finishedAt,
      },
    });
    if (updated.count === 0) return null;

    return prisma.import_batches.findFirst({
      where: { id: input.batchId, tenant_id: input.tenantId },
      select: batchSelect,
    });
  },

  findById(tenantId: string, batchId: string) {
    return prisma.import_batches.findFirst({
      where: { id: batchId, tenant_id: tenantId },
      select: batchSelect,
    });
  },
};
