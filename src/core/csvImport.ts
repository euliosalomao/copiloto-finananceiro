import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import { z } from "zod";
import {
  transactionDirectionSchema,
  transactionOperationTypeSchema,
} from "./schemas/zod.js";

export const CSV_MAX_BYTES = 2 * 1024 * 1024;
export const CSV_MAX_ROWS = 1000;
const requiredHeaders = [
  "transactionDate", "description", "amount", "direction", "operationType",
];
const allowedHeaders = [...requiredHeaders, "externalId", "notes"];

// O decimal é mantido como texto até chegar ao Decimal do PostgreSQL.
const amountSchema = z.string()
  .regex(/^\d{1,12}([.,]\d{1,2})?$/, "Use um valor não negativo, sem milhar e com até 2 casas decimais.")
  .transform((value) => {
    const [integer, fraction = ""] = value.replace(",", ".").split(".");
    return `${BigInt(integer!)}.${fraction.padEnd(2, "0")}`;
  });

const rowSchema = z.object({
  transactionDate: z.iso.date("Use uma data válida no formato YYYY-MM-DD.")
    .refine((value) => !value.startsWith("0000"), "O ano deve ser maior que zero."),
  description: z.string().trim().min(1).max(255),
  amount: amountSchema,
  direction: transactionDirectionSchema,
  operationType: transactionOperationTypeSchema,
  externalId: z.string().trim().max(200).default(""),
  notes: z.string().trim().max(2000).default(""),
}).superRefine((row, ctx) => {
  for (const field of ["description", "notes", "externalId"] as const) {
    if (row[field].includes("\0")) {
      ctx.addIssue({ code: "custom", path: [field], message: "Caractere nulo não permitido." });
    }
  }
  if (
    (row.operationType === "INCOME" && row.direction !== "INFLOW") ||
    (row.operationType === "EXPENSE" && row.direction !== "OUTFLOW")
  ) {
    ctx.addIssue({ code: "custom", path: ["direction"], message: "INCOME exige INFLOW; EXPENSE exige OUTFLOW." });
  }
});

export type CsvValues = z.infer<typeof rowSchema>;
export type CsvRow = {
  rowNumber: number;
  line: number;
  raw: string[];
  values: CsvValues | null;
  importKey: string | null;
  errors: { field: string; message: string }[];
};
export type ParsedCsv = { fileHash: string; delimiter: string; headers: string[]; rows: CsvRow[] };
export type ImportCandidate = {
  id: string;
  importKey: string | null;
  ignored: boolean;
  transactionDate: string;
  description: string;
  amount: string;
  direction: string;
  operationType: string;
};
export type Duplicate = {
  kind: "ALREADY_IMPORTED" | "REPEATED_EXTERNAL_ID" | "POSSIBLE_IN_FILE" | "POSSIBLE_IN_DATABASE";
  rowNumber?: number;
  transactionId?: string;
  ignored?: boolean;
};
export type PreviewRow = CsvRow & {
  status: "VALID" | "INVALID" | "DUPLICATE" | "POSSIBLE_DUPLICATE";
  duplicates: Duplicate[];
};
export type CsvPreview = {
  previewToken: string;
  accountId: string;
  delimiter: string;
  headers: string[];
  canImport: boolean;
  summary: { totalRows: number; validRows: number; invalidRows: number; duplicateRows: number; possibleDuplicateRows: number };
  rows: PreviewRow[];
};

export class CsvImportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number = 400,
    public readonly preview?: CsvPreview,
  ) {
    super(message);
    this.name = "CsvImportError";
  }
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function previewToken(tenantId: string, accountId: string, fileHash: string): string {
  // Vincula a confirmação ao arquivo/conta da tela. Não é autenticação.
  return hash(JSON.stringify(["csv-v1", tenantId.toLowerCase(), accountId.toLowerCase(), fileHash]));
}

export function fingerprint(row: Pick<ImportCandidate, "transactionDate" | "description" | "amount" | "direction" | "operationType">): string {
  return JSON.stringify([
    row.transactionDate,
    row.description.normalize("NFC").trim().replace(/\s+/g, " ").toUpperCase(),
    row.amount,
    row.direction,
    row.operationType,
  ]);
}

export function parseCsv(file: Buffer, accountId: string): ParsedCsv {
  if (file.length > CSV_MAX_BYTES) {
    throw new CsvImportError("CSV_TOO_LARGE", "O limite é 2 MiB por arquivo.", 413);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file);
  } catch {
    throw new CsvImportError("CSV_ENCODING", "Salve o CSV com codificação UTF-8.");
  }
  if (!text.trim()) throw new CsvImportError("CSV_EMPTY", "O arquivo está vazio.");

  let delimiter: string | undefined;
  for (const candidate of [",", ";"]) {
    try {
      const first = parse(text, { bom: true, delimiter: candidate, trim: true, skip_empty_lines: true, to: 1 }) as string[][];
      if (requiredHeaders.every((header) => first[0]?.includes(header))) {
        delimiter = candidate;
        break;
      }
    } catch { /* A tentativa com o outro separador ainda pode ser válida. */ }
  }
  if (!delimiter) {
    throw new CsvImportError("CSV_HEADERS", `Cabeçalho obrigatório: ${requiredHeaders.join(",")}. Separador: vírgula ou ponto e vírgula.`);
  }

  let records: { record: string[]; info: { lines: number } }[];
  try {
    records = parse(text, {
      bom: true, delimiter, trim: true, skip_empty_lines: true,
      relax_column_count: true, info: true, max_record_size: 64 * 1024,
      to: CSV_MAX_ROWS + 2,
    }) as unknown as typeof records; // info:true retorna { record, info }, não apenas string[].
  } catch {
    throw new CsvImportError("CSV_MALFORMED", "CSV malformado: verifique aspas, separadores e tamanho dos registros.");
  }
  const headers = records.shift()!.record;
  if (new Set(headers).size !== headers.length || headers.some((header) => !allowedHeaders.includes(header))) {
    throw new CsvImportError("CSV_HEADERS", `Não repita colunas. Colunas permitidas: ${allowedHeaders.join(",")}.`);
  }
  if (records.length === 0) throw new CsvImportError("CSV_EMPTY", "O CSV precisa ter ao menos uma transação.");
  if (records.length > CSV_MAX_ROWS) throw new CsvImportError("CSV_TOO_MANY_ROWS", "O limite é 1000 transações por arquivo.", 413);

  const fileHash = hash(file);
  const rows = records.map(({ record, info }, index): CsvRow => {
    const base = { rowNumber: index + 1, line: info.lines, raw: record, values: null, importKey: null };
    if (record.length !== headers.length) {
      return { ...base, errors: [{ field: "row", message: "Quantidade de campos diferente do cabeçalho." }] };
    }
    const result = rowSchema.safeParse(Object.fromEntries(headers.map((header, i) => [header, record[i]])));
    if (!result.success) {
      return { ...base, errors: result.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })) };
    }
    const values = result.data;
    // Sem ID do banco, só garantimos identidade do mesmo arquivo + posição.
    // Compras iguais em arquivos diferentes são alertas, não certeza de duplicata.
    const identity = values.externalId ? ["external", values.externalId] : ["file", fileHash, index + 1];
    const importKey = `csv:v1:${hash(JSON.stringify([accountId.toLowerCase(), ...identity]))}`;
    return { ...base, values, importKey, errors: [] };
  });
  return { fileHash, delimiter, headers, rows };
}

export function buildPreview(
  parsed: ParsedCsv,
  tenantId: string,
  accountId: string,
  candidates: ImportCandidate[],
  allowPossibleDuplicates = false,
): CsvPreview {
  const existingKeys = new Map(candidates.filter((row) => row.importKey).map((row) => [row.importKey, row]));
  const existingContent = new Map(candidates.map((row) => [fingerprint(row), row]));
  const seenKeys = new Map<string, number>();
  const seenContent = new Map<string, number>();

  const rows = parsed.rows.map((row): PreviewRow => {
    if (!row.values || !row.importKey) return { ...row, status: "INVALID", duplicates: [] };
    const duplicates: Duplicate[] = [];
    const known = existingKeys.get(row.importKey);
    if (known) duplicates.push({ kind: "ALREADY_IMPORTED", transactionId: known.id, ignored: known.ignored });
    const repeatedId = seenKeys.get(row.importKey);
    if (repeatedId !== undefined) duplicates.push({ kind: "REPEATED_EXTERNAL_ID", rowNumber: repeatedId });
    const content = fingerprint(row.values);
    const repeatedContent = seenContent.get(content);
    if (repeatedContent !== undefined) duplicates.push({ kind: "POSSIBLE_IN_FILE", rowNumber: repeatedContent });
    const possible = existingContent.get(content);
    if (possible && !known) duplicates.push({ kind: "POSSIBLE_IN_DATABASE", transactionId: possible.id, ignored: possible.ignored });
    seenKeys.set(row.importKey, row.rowNumber);
    seenContent.set(content, row.rowNumber);
    const certain = duplicates.some((duplicate) => duplicate.kind === "ALREADY_IMPORTED" || duplicate.kind === "REPEATED_EXTERNAL_ID");
    return { ...row, duplicates, status: certain ? "DUPLICATE" : duplicates.length ? "POSSIBLE_DUPLICATE" : "VALID" };
  });

  const summary = {
    totalRows: rows.length,
    validRows: rows.filter((row) => row.status === "VALID").length,
    invalidRows: rows.filter((row) => row.status === "INVALID").length,
    duplicateRows: rows.filter((row) => row.status === "DUPLICATE").length,
    possibleDuplicateRows: rows.filter((row) => row.status === "POSSIBLE_DUPLICATE").length,
  };
  return {
    accountId, previewToken: previewToken(tenantId, accountId, parsed.fileHash),
    delimiter: parsed.delimiter, headers: parsed.headers, rows, summary,
    canImport: summary.invalidRows === 0 && summary.duplicateRows === 0 &&
      (summary.possibleDuplicateRows === 0 || allowPossibleDuplicates),
  };
}

export function requireImportable(preview: CsvPreview): void {
  if (preview.summary.invalidRows > 0) {
    throw new CsvImportError("CSV_INVALID_ROWS", "Corrija as linhas inválidas e gere um novo preview. Nada foi gravado.", 422, preview);
  }
  if (!preview.canImport) {
    throw new CsvImportError("CSV_DUPLICATES", "O lote contém duplicatas ou possíveis duplicatas não confirmadas. Nada foi gravado.", 409, preview);
  }
}
