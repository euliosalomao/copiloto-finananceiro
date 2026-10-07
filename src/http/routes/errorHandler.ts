import type {
  FastifyInstance,
} from "fastify";

import { ZodError } from "zod";
import { CsvImportError } from "../../core/csvImport.js";
import { StatementImportError } from "../../services/statementImportService.js";

import { Prisma } from "../../generated/prisma/client.js";

import { DomainErrorCode } from "../../core/schemas/types.js";

import {
  DomainError
} from "../../core/errors.js";

type HttpError = Error & {
  statusCode: number;
  code?: string;
};

function isHttpError(error: unknown): error is HttpError {
  return (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number"
  );
}

function getDomainErrorStatus(
  code: DomainErrorCode,
): number {
  switch (code) {
    /*
     * 404 — recurso não encontrado
     */
    case "TRANSACTION_NOT_FOUND":
    case "ACCOUNT_NOT_FOUND":
    case "CATEGORY_NOT_FOUND":
    case "PENDING_CLASSIFICATION_NOT_FOUND":
    case "CLASSIFICATION_REVIEW_NOT_FOUND":
      return 404;

    /*
     * 409 — estado atual impede a operação
     */
    case "TRANSACTION_ALREADY_EXISTS":
    case "MERCHANT_RULE_ALREADY_EXISTS":
    case "CLASSIFICATION_ALREADY_CONFIRMED":
    case "CLASSIFICATION_REVIEW_NOT_WAITING":
    case "CLASSIFICATION_REVIEW_MESSAGE_CONFLICT":
      return 409;

    /*
     * 400 — entrada válida estruturalmente,
     * mas inválida para a regra de negócio
     */
    case "MERCHANT_RULE_DATA_REQUIRED":
    case "INVALID_TRANSACTION_OPERATION":
      return 400;

    default:
      return 400;
  }
}

export function registerErrorHandler(
  app: FastifyInstance,
) {
  app.setErrorHandler(
    async (error, request, reply) => {
      if (error instanceof CsvImportError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
          ...(error.preview && { preview: error.preview }),
        });
      }
      if (error instanceof StatementImportError) {
        return reply.status(error.statusCode).send({
          error: error.code,
          message: error.message,
          ...(error.details && { details: error.details }),
        });
      }
      /*
       * Zod
       */
      if (error instanceof ZodError) {
        return reply.status(400).send({
          error: "VALIDATION_ERROR",
          message: "Invalid request data",

          details: error.issues.map(
            (issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            }),
          ),
        });
      }

      /*
       * Regras do domínio
       */
      if (error instanceof DomainError) {
        return reply
          .status(
            getDomainErrorStatus(
              error.code,
            ),
          )
          .send({
            error: error.code,
            message: error.message,
          });
      }

      /*
       * Constraint unique do Prisma
       */
      
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return reply.status(409).send({
          error: "RESOURCE_CONFLICT",
          message:
            "A resource with these values already exists.",
        });
      }

      /*
       * Registro não encontrado pelo Prisma
       */
      if (
        error instanceof
          Prisma.PrismaClientKnownRequestError &&
        error.code === "P2025"
      ) {
        return reply.status(404).send({
          error: "RESOURCE_NOT_FOUND",
          message: "Resource not found.",
        });
      }

      /*
       * Erros HTTP produzidos pelo próprio Fastify
       */
      if (
        isHttpError(error) &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        return reply.status(error.statusCode).send({
          error: error.code ?? "BAD_REQUEST",
          message: error.message,
        });
      }

      /*
       * Erro inesperado
       */
      request.log.error(
        {
          error,
          requestId: request.id,
        },
        "Unexpected application error",
      );

      return reply.status(500).send({
        error: "INTERNAL_SERVER_ERROR",
        message: "Internal server error.",
      });
    },
  );
}
