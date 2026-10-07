import {
  buildPreview, CsvImportError, parseCsv, previewToken, requireImportable,
  type CsvRow, type ImportCandidate,
} from "../core/csvImport.js";

export type ImportSession = {
  findCandidates(rows: CsvRow[]): Promise<ImportCandidate[]>;
  save(rows: CsvRow[]): Promise<string[]>;
};
export type ImportRepository = {
  inspect(tenantId: string, accountId: string, rows: CsvRow[]): Promise<ImportCandidate[]>;
  withAccountLock<T>(tenantId: string, accountId: string, work: (session: ImportSession) => Promise<T>): Promise<T>;
};
export type CsvImportInput = {
  accountId: string;
  file: Buffer;
  allowPossibleDuplicates: boolean;
};

// A dependência explícita permite testar o fluxo sem conectar ao banco real.
export function createImportService(repository: ImportRepository) {
  return {
    async preview(tenantId: string, input: CsvImportInput) {
      const parsed = parseCsv(input.file, input.accountId);
      const candidates = await repository.inspect(tenantId, input.accountId, parsed.rows);
      return buildPreview(parsed, tenantId, input.accountId, candidates, input.allowPossibleDuplicates);
    },

    async commit(tenantId: string, input: CsvImportInput & { previewToken: string }) {
      const parsed = parseCsv(input.file, input.accountId);
      if (input.previewToken !== previewToken(tenantId, input.accountId, parsed.fileHash)) {
        throw new CsvImportError("CSV_PREVIEW_CHANGED", "Arquivo ou conta diferente do preview. Gere o preview novamente.", 409);
      }

      return repository.withAccountLock(tenantId, input.accountId, async (session) => {
        // Outra importação pode ter ocorrido depois do preview: verificamos de novo.
        const candidates = await session.findCandidates(parsed.rows);
        const preview = buildPreview(parsed, tenantId, input.accountId, candidates, input.allowPossibleDuplicates);
        requireImportable(preview);
        const transactionIds = await session.save(parsed.rows);
        return {
          importedCount: transactionIds.length,
          pendingReviewCount: transactionIds.length,
          transactionIds,
          previewToken: preview.previewToken,
        };
      });
    },
  };
}

export type CsvImportService = ReturnType<typeof createImportService>;
