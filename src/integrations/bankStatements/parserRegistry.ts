import type {
  BankStatementFormat,
  BankStatementParseInput,
  BankStatementParser,
  ParsedBankStatement,
} from "./types.js";

export class BankStatementParserRegistryError extends Error {
  constructor(
    public readonly code:
      | "DUPLICATE_BANK_STATEMENT_PARSER"
      | "BANK_STATEMENT_FORMAT_UNSUPPORTED"
      | "BANK_STATEMENT_FORMAT_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "BankStatementParserRegistryError";
  }
}

export class BankStatementParserRegistry {
  private readonly parsers: ReadonlyMap<
    BankStatementFormat,
    BankStatementParser
  >;

  constructor(parsers: readonly BankStatementParser[]) {
    const byFormat = new Map<
      BankStatementFormat,
      BankStatementParser
    >();

    for (const parser of parsers) {
      if (byFormat.has(parser.format)) {
        throw new BankStatementParserRegistryError(
          "DUPLICATE_BANK_STATEMENT_PARSER",
          `Já existe um parser registrado para ${parser.format}.`,
        );
      }

      byFormat.set(parser.format, parser);
    }

    this.parsers = byFormat;
  }

  get(format: BankStatementFormat): BankStatementParser {
    const parser = this.parsers.get(format);

    if (!parser) {
      throw new BankStatementParserRegistryError(
        "BANK_STATEMENT_FORMAT_UNSUPPORTED",
        `O formato ${format} ainda não possui parser.`,
      );
    }

    return parser;
  }

  parse(
    format: BankStatementFormat,
    input: BankStatementParseInput,
  ): ParsedBankStatement {
    const parser = this.get(format);

    if (!parser.canParse(input)) {
      throw new BankStatementParserRegistryError(
        "BANK_STATEMENT_FORMAT_MISMATCH",
        `O arquivo não corresponde ao formato ${format}.`,
      );
    }

    return parser.parse(input);
  }
}
