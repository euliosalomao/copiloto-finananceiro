import { InterCsvParser } from "./inter/interCsvParser.js";
import { BankStatementParserRegistry } from "./parserRegistry.js";

export const bankStatementParserRegistry =
  new BankStatementParserRegistry([
    new InterCsvParser(),
  ]);

export * from "./types.js";
export * from "./parserRegistry.js";
export * from "./inter/interCsvParser.js";
