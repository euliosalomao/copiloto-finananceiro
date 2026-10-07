import fastify from "fastify";
import { accountRoutes } from "./http/routes/routes/accountRoutes.js";
import { categoryRoutes } from "./http/routes/routes/categoryRoutes.js";
import { classificationRoutes } from "./http/routes/routes/classificationRoutes.js";
import { classificationReviewRoutes } from "./http/routes/routes/classificationReviewRoutes.js";
import { createTransactionRoute } from "./http/routes/routes/createTransactionRoute.js";
import { deleteTransactionRoute } from "./http/routes/routes/deleteTransactionRoute.js";
import { getTransactionByIdRoute } from "./http/routes/routes/getTransactionByIdRoute.js";
import { getTransactionsRoute } from "./http/routes/routes/getTransactionRoute.js";
import { healthRoutes } from "./http/routes/routes/healthRoutes.js";
import { importRoutes } from "./http/routes/routes/importRoutes.js";
import { reportRoutes } from "./http/routes/routes/reportRoutes.js";
import { statementImportRoutes } from "./http/routes/routes/statementImportRoutes.js";
import { updateTransactionRoute } from "./http/routes/routes/updateTransactionRoute.js";
import { registerErrorHandler } from "./http/routes/errorHandler.js";
import { registerN8nAuth } from "./http/routes/auth/n8nAuth.js";
import { importRepository } from "./data/importRepository.js";
import { importBatchesRepository } from "./data/importBatchesRepository.js";
import { statementImportRepository } from "./data/statementImportRepository.js";
import { bankStatementParserRegistry } from "./integrations/bankStatements/index.js";
import { createImportService } from "./services/importService.js";
import { classifyTransaction } from "./services/classificationService.js";
import { createStatementImportService } from "./services/statementImportService.js";

const REQUEST_BODY_LIMIT_BYTES = 6 * 1024 * 1024;

export type BuildAppOptions = {
  n8nApiToken: string;
  logLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions) {
  const app = fastify({
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
    logger: options.logger ?? {
      level: options.logLevel ?? "info",
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          "res.headers.set-cookie",
        ],
        censor: "[REDACTED]",
      },
    },
  });

  registerErrorHandler(app);
  registerN8nAuth(app, options.n8nApiToken);

  app.register(healthRoutes);
  app.register(getTransactionsRoute);
  app.register(getTransactionByIdRoute);
  app.register(createTransactionRoute);
  app.register(updateTransactionRoute);
  app.register(deleteTransactionRoute);
  app.register(reportRoutes);
  app.register(classificationRoutes);
  app.register(classificationReviewRoutes);
  app.register(categoryRoutes);
  app.register(accountRoutes);
  app.register(importRoutes, { service: createImportService(importRepository) });
  app.register(statementImportRoutes, {
    service: createStatementImportService({
      parserRegistry: bankStatementParserRegistry,
      batches: importBatchesRepository,
      repository: statementImportRepository,
      classifyTransaction,
    }),
  });

  return app;
}
