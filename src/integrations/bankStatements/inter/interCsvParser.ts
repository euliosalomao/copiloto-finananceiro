import { parse } from "csv-parse/sync";
import type { TransactionOperationType } from "../../../core/schemas/types.js";
import type {
  BankStatementIssue,
  BankStatementParseInput,
  BankStatementParser,
  NormalizedStatementTransaction,
  ParsedBankStatement,
} from "../types.js";

export const INTER_CSV_MAX_BYTES = 2 * 1024 * 1024;
export const INTER_CSV_MAX_TRANSACTIONS = 1000;

const expectedHeaders = [
  "Data Lançamento",
  "Histórico",
  "Descrição",
  "Valor",
  "Saldo",
] as const;

export type InterCsvParserErrorCode =
  | "INTER_CSV_TOO_LARGE"
  | "INTER_CSV_ENCODING"
  | "INTER_CSV_EMPTY"
  | "INTER_CSV_SIGNATURE"
  | "INTER_CSV_METADATA"
  | "INTER_CSV_HEADERS"
  | "INTER_CSV_MALFORMED"
  | "INTER_CSV_TOO_MANY_TRANSACTIONS"
  | "INTER_CSV_INVALID_ROW"
  | "INTER_CSV_INVALID_ORDER"
  | "INTER_CSV_BALANCE_MISMATCH";

export class InterCsvParserError extends Error {
  constructor(
    public readonly code: InterCsvParserErrorCode,
    message: string,
    public readonly rowNumber?: number,
    public readonly field?: string,
  ) {
    super(message);
    this.name = "InterCsvParserError";
  }
}

type Money = {
  cents: bigint;
  decimal: string;
  absoluteDecimal: string;
};

type ParsedRow = {
  transaction: NormalizedStatementTransaction;
  signedAmountCents: bigint;
  balanceCents: bigint;
};

type CsvRecord = {
  record: string[];
  info: { lines: number };
};

function normalizeLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function decodeUtf8(file: Buffer): string {
  if (file.length > INTER_CSV_MAX_BYTES) {
    throw new InterCsvParserError(
      "INTER_CSV_TOO_LARGE",
      "O extrato do Inter excede o limite de 2 MiB.",
    );
  }

  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(file)
      .replace(/^\uFEFF/, "");
  } catch {
    throw new InterCsvParserError(
      "INTER_CSV_ENCODING",
      "O extrato do Inter precisa estar em UTF-8.",
    );
  }
}

function findHeaderLine(lines: readonly string[]): number {
  const normalizedExpected = expectedHeaders.map(normalizeLabel);

  return lines.findIndex((line, index) => {
    if (index > 20) return false;
    const cells = line.split(";").map(normalizeLabel);
    return cells.length === normalizedExpected.length &&
      cells.every((cell, cellIndex) => cell === normalizedExpected[cellIndex]);
  });
}

function parseIsoDate(
  value: string,
  rowNumber: number | undefined,
  field: string,
): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) {
    throw new InterCsvParserError(
      "INTER_CSV_INVALID_ROW",
      `Data inválida em ${field}; use DD/MM/AAAA.`,
      rowNumber,
      field,
    );
  }

  const [, day, month, year] = match;
  const iso = `${year}-${month}-${day}`;
  const date = new Date(`${iso}T00:00:00.000Z`);

  if (
    year === "0000" ||
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso
  ) {
    throw new InterCsvParserError(
      "INTER_CSV_INVALID_ROW",
      `Data inválida em ${field}.`,
      rowNumber,
      field,
    );
  }

  return iso;
}

function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const integer = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${integer}.${fraction}`;
}

function parseMoney(
  value: string,
  rowNumber: number | undefined,
  field: string,
): Money {
  const trimmed = value.trim();
  const match = /^(-?)(?:(0|[1-9]\d{0,2}(?:\.\d{3})*)|([1-9]\d{3,})),(\d{2})$/.exec(trimmed);

  if (!match) {
    throw new InterCsvParserError(
      "INTER_CSV_INVALID_ROW",
      `Valor monetário inválido em ${field}.`,
      rowNumber,
      field,
    );
  }

  const integer = (match[2] ?? match[3]!).replace(/\./g, "");
  if (integer.length > 12) {
    throw new InterCsvParserError(
      "INTER_CSV_INVALID_ROW",
      `Valor monetário fora do limite em ${field}.`,
      rowNumber,
      field,
    );
  }

  const absoluteCents = BigInt(integer) * 100n + BigInt(match[4]!);
  const cents = match[1] === "-" ? -absoluteCents : absoluteCents;

  return {
    cents,
    decimal: formatCents(cents),
    absoluteDecimal: formatCents(absoluteCents),
  };
}

function metadataValue(
  lines: readonly string[],
  headerLine: number,
  key: "conta" | "periodo" | "saldo",
): string {
  for (let index = 0; index < headerLine; index++) {
    const [label, ...rest] = lines[index]!.split(";");
    if (normalizeLabel(label ?? "") === key) {
      const value = rest.join(";").trim();
      if (value) return value;
      break;
    }
  }

  throw new InterCsvParserError(
    "INTER_CSV_METADATA",
    `Metadado obrigatório ausente: ${key}.`,
  );
}

function operationTypeHint(
  sourceType: string,
  direction: "INFLOW" | "OUTFLOW",
): TransactionOperationType | null {
  const normalized = normalizeLabel(sourceType);

  if (normalized === "compra no debito" && direction === "OUTFLOW") {
    return "EXPENSE";
  }

  if (/\b(tarifa|encargo|juros)\b/.test(normalized) && direction === "OUTFLOW") {
    return "EXPENSE";
  }

  if (/\brendimento\b/.test(normalized) && direction === "INFLOW") {
    return "INCOME";
  }

  return null;
}

function parseRecords(
  lines: readonly string[],
  headerLine: number,
): CsvRecord[] {
  const table = lines.slice(headerLine).join("\n");

  try {
    return parse(table, {
      bom: true,
      delimiter: ";",
      info: true,
      max_record_size: 64 * 1024,
      relax_column_count: false,
      skip_empty_lines: true,
      to: INTER_CSV_MAX_TRANSACTIONS + 2,
    }) as unknown as CsvRecord[];
  } catch {
    throw new InterCsvParserError(
      "INTER_CSV_MALFORMED",
      "A tabela do extrato Inter está malformada.",
    );
  }
}

function validateHeaders(headers: readonly string[]): void {
  if (
    headers.length !== expectedHeaders.length ||
    !headers.every(
      (header, index) => normalizeLabel(header) === normalizeLabel(expectedHeaders[index]!),
    )
  ) {
    throw new InterCsvParserError(
      "INTER_CSV_HEADERS",
      `Cabeçalho esperado: ${expectedHeaders.join(";")}.`,
    );
  }
}

function hasInterSignature(text: string): boolean {
  if (!text.trim()) return false;
  const lines = text.split(/\r?\n/);
  return normalizeLabel(lines[0] ?? "") === "extrato conta corrente" &&
    findHeaderLine(lines) >= 0;
}

export class InterCsvParser implements BankStatementParser {
  readonly provider = "INTER" as const;
  readonly format = "INTER_CSV" as const;

  canParse(input: BankStatementParseInput): boolean {
    try {
      return hasInterSignature(decodeUtf8(input.file));
    } catch {
      return false;
    }
  }

  parse(input: BankStatementParseInput): ParsedBankStatement {
    const text = decodeUtf8(input.file);
    if (!text.trim()) {
      throw new InterCsvParserError(
        "INTER_CSV_EMPTY",
        "O extrato do Inter está vazio.",
      );
    }
    if (!hasInterSignature(text)) {
      throw new InterCsvParserError(
        "INTER_CSV_SIGNATURE",
        "O arquivo não corresponde ao CSV de conta corrente do Inter.",
      );
    }

    const lines = text.split(/\r?\n/);
    const headerLine = findHeaderLine(lines);
    const accountReference = metadataValue(lines, headerLine, "conta");
    const period = metadataValue(lines, headerLine, "periodo");
    const closingBalance = parseMoney(
      metadataValue(lines, headerLine, "saldo"),
      undefined,
      "Saldo",
    );
    const periodMatch = /^(\d{2}\/\d{2}\/\d{4})\s+a\s+(\d{2}\/\d{2}\/\d{4})$/.exec(period);
    if (!periodMatch) {
      throw new InterCsvParserError(
        "INTER_CSV_METADATA",
        "Período inválido no cabeçalho do extrato.",
      );
    }

    const periodStart = parseIsoDate(periodMatch[1]!, undefined, "Período inicial");
    const periodEnd = parseIsoDate(periodMatch[2]!, undefined, "Período final");
    if (periodStart > periodEnd) {
      throw new InterCsvParserError(
        "INTER_CSV_METADATA",
        "O período inicial do extrato é posterior ao período final.",
      );
    }

    const records = parseRecords(lines, headerLine);
    const header = records.shift();
    if (!header) {
      throw new InterCsvParserError(
        "INTER_CSV_HEADERS",
        "O cabeçalho da tabela não foi encontrado.",
      );
    }
    validateHeaders(header.record);

    if (records.length === 0) {
      throw new InterCsvParserError(
        "INTER_CSV_EMPTY",
        "O extrato precisa ter pelo menos uma transação.",
      );
    }
    if (records.length > INTER_CSV_MAX_TRANSACTIONS) {
      throw new InterCsvParserError(
        "INTER_CSV_TOO_MANY_TRANSACTIONS",
        `O limite é ${INTER_CSV_MAX_TRANSACTIONS} transações por extrato.`,
      );
    }

    const issues: BankStatementIssue[] = [];
    const parsedRows = records.map(({ record, info }): ParsedRow => {
      const rowNumber = headerLine + info.lines;
      if (record.length !== expectedHeaders.length) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "Quantidade de campos diferente do cabeçalho.",
          rowNumber,
        );
      }
      if (record.some((value) => value.includes("\0"))) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "Caractere nulo não permitido.",
          rowNumber,
        );
      }

      const [rawDate, rawSourceType, rawDescription, rawAmount, rawBalance] = record as [
        string,
        string,
        string,
        string,
        string,
      ];
      const transactionDate = parseIsoDate(rawDate, rowNumber, "Data Lançamento");
      if (transactionDate < periodStart || transactionDate > periodEnd) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "A transação está fora do período declarado no extrato.",
          rowNumber,
          "Data Lançamento",
        );
      }

      const sourceType = rawSourceType.trim().replace(/\s+/g, " ");
      if (!sourceType) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "O histórico da transação é obrigatório.",
          rowNumber,
          "Histórico",
        );
      }

      const amount = parseMoney(rawAmount, rowNumber, "Valor");
      if (amount.cents === 0n) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "A transação não pode ter valor zero.",
          rowNumber,
          "Valor",
        );
      }
      const balance = parseMoney(rawBalance, rowNumber, "Saldo");
      const direction = amount.cents > 0n ? "INFLOW" : "OUTFLOW";
      const normalizedDescription = rawDescription.trim().replace(/\s+/g, " ");
      const description = normalizedDescription || sourceType;
      if (description.length > 255) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ROW",
          "A descrição pode ter no máximo 255 caracteres.",
          rowNumber,
          "Descrição",
        );
      }

      if (!normalizedDescription) {
        issues.push({
          severity: "WARNING",
          code: "INTER_CSV_DESCRIPTION_FALLBACK",
          message: "Descrição vazia; o histórico foi usado como fallback.",
          rowNumber,
          field: "Descrição",
        });
      }

      const raw = Object.freeze(Object.fromEntries(
        expectedHeaders.map((name, index) => [name, record[index] ?? ""]),
      ));
      const transaction: NormalizedStatementTransaction = {
        rowNumber,
        transactionDate,
        description,
        amount: amount.absoluteDecimal,
        direction,
        operationTypeHint: operationTypeHint(sourceType, direction),
        externalId: null,
        balanceAfter: balance.decimal,
        sourceType,
        raw,
      };

      return {
        transaction,
        signedAmountCents: amount.cents,
        balanceCents: balance.cents,
      };
    });

    for (let index = 1; index < parsedRows.length; index++) {
      const newer = parsedRows[index - 1]!;
      const older = parsedRows[index]!;

      if (older.transaction.transactionDate > newer.transaction.transactionDate) {
        throw new InterCsvParserError(
          "INTER_CSV_INVALID_ORDER",
          "As transações precisam estar ordenadas da mais nova para a mais antiga.",
          older.transaction.rowNumber,
          "Data Lançamento",
        );
      }

      const expectedNewerBalance = older.balanceCents + newer.signedAmountCents;
      if (newer.balanceCents !== expectedNewerBalance) {
        issues.push({
          severity: "WARNING",
          code: "INTER_CSV_BALANCE_MISMATCH",
          message:
            `Saldo entre transações não reconciliado: esperado ${formatCents(expectedNewerBalance)}, encontrado ${formatCents(newer.balanceCents)}.`,
          rowNumber: newer.transaction.rowNumber,
          field: "Saldo",
        });
      }
    }

    if (parsedRows[0]!.balanceCents !== closingBalance.cents) {
      issues.push({
        severity: "WARNING",
        code: "INTER_CSV_BALANCE_MISMATCH",
        message:
          `Saldo do cabeçalho não coincide com a transação mais recente: cabeçalho ${closingBalance.decimal}, transação ${formatCents(parsedRows[0]!.balanceCents)}.`,
        rowNumber: parsedRows[0]!.transaction.rowNumber,
        field: "Saldo",
      });
    }

    return {
      provider: this.provider,
      format: this.format,
      metadata: {
        externalAccountReference: accountReference,
        periodStart,
        periodEnd,
        closingBalance: closingBalance.decimal,
      },
      transactions: parsedRows.map((row) => row.transaction),
      issues,
    };
  }
}

export const interCsvParser = new InterCsvParser();
