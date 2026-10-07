import type {
  TransactionDirection,
  TransactionOperationType,
} from "../../core/schemas/types.js";
import { z } from "zod";

export const bankStatementFormatSchema = z.enum(["INTER_CSV"]);

export type BankStatementFormat = z.infer<
  typeof bankStatementFormatSchema
>;

export type BankStatementParseInput = {
  file: Buffer;
  fileName: string;
  mimeType?: string;
};

export type BankStatementMetadata = {
  externalAccountReference: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  closingBalance: string | null;
};

export type BankStatementIssue = {
  severity: "WARNING" | "ERROR";
  code: string;
  message: string;
  rowNumber?: number;
  field?: string;
};

export type NormalizedStatementTransaction = {
  rowNumber: number;
  transactionDate: string;
  description: string;
  amount: string;
  direction: TransactionDirection;
  // O extrato descreve o movimento, mas nem sempre revela se um PIX é uma
  // despesa, transferência entre contas ou investimento. A classificação
  // definitiva pertence ao domínio, não ao parser do banco.
  operationTypeHint: TransactionOperationType | null;
  externalId: string | null;
  balanceAfter: string | null;
  sourceType: string | null;
  raw: Readonly<Record<string, string>>;
};

export type ParsedBankStatement = {
  provider: string;
  format: BankStatementFormat;
  metadata: BankStatementMetadata;
  transactions: NormalizedStatementTransaction[];
  issues: BankStatementIssue[];
};

export interface BankStatementParser {
  readonly provider: string;
  readonly format: BankStatementFormat;

  /** Confirma que o arquivo tem a assinatura esperada antes do parse. */
  canParse(input: BankStatementParseInput): boolean;

  /** Apenas traduz o arquivo externo; não acessa banco nem classifica. */
  parse(input: BankStatementParseInput): ParsedBankStatement;
}
