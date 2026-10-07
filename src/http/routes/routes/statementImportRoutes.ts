import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { bankStatementFormatSchema } from "../../../integrations/bankStatements/types.js";
import {
  StatementImportError,
  type StatementImportService,
} from "../../../services/statementImportService.js";
import { getTenantId } from "../auth/getTenantId.js";

const STATEMENT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

const fieldsSchema = z.strictObject({
  accountId: z.uuid().transform((value) => value.toLowerCase()),
  format: bankStatementFormatSchema,
  source: z.enum(["MANUAL", "GMAIL", "N8N"]).default("MANUAL"),
  sourceMessageId: z.string().trim().min(1).max(512).optional(),
  sourceAttachmentId: z.string().trim().min(1).max(512).optional(),
}).refine(
  (fields) => !fields.sourceAttachmentId || Boolean(fields.sourceMessageId),
  {
    path: ["sourceAttachmentId"],
    message: "sourceAttachmentId exige sourceMessageId.",
  },
);

async function readStatementUpload(request: FastifyRequest) {
  if (!request.isMultipart()) {
    throw new StatementImportError(
      "STATEMENT_MULTIPART_REQUIRED",
      "Envie multipart/form-data com accountId, format e file.",
      415,
    );
  }

  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let fileName: string | undefined;
  let mimeType: string | undefined;
  let interrupted = false;

  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || file !== undefined) {
        part.file.resume();
        throw new StatementImportError(
          "STATEMENT_FILE_REQUIRED",
          "Envie apenas um arquivo no campo file.",
          400,
        );
      }
      try {
        fileName = part.filename;
        mimeType = part.mimetype;
        file = await part.toBuffer();
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) ||
          error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
          throw error;
        }
        interrupted = true;
      }
    } else {
      if (part.fieldnameTruncated || part.valueTruncated) {
        throw new StatementImportError(
          "STATEMENT_FIELD_TOO_LARGE",
          "Campo multipart excedeu o limite.",
          413,
        );
      }
      if (Object.hasOwn(fields, part.fieldname) ||
        typeof part.value !== "string") {
        throw new StatementImportError(
          "STATEMENT_FIELDS_INVALID",
          "Não repita campos multipart; envie valores em texto.",
          400,
        );
      }
      Object.defineProperty(fields, part.fieldname, {
        value: part.value,
        enumerable: true,
      });
    }
  }

  if (interrupted) {
    throw new StatementImportError(
      "STATEMENT_UPLOAD_INCOMPLETE",
      "Upload interrompido. Envie o arquivo novamente.",
      400,
    );
  }
  if (!file || !fileName) {
    throw new StatementImportError(
      "STATEMENT_FILE_REQUIRED",
      "Envie um arquivo no campo file.",
      400,
    );
  }

  return {
    ...fieldsSchema.parse(fields),
    file,
    fileName,
    mimeType,
  };
}

export async function statementImportRoutes(
  app: FastifyInstance,
  options: { service: StatementImportService },
) {
  await app.register(multipart, {
    limits: {
      files: 1,
      fields: 5,
      parts: 6,
      fileSize: STATEMENT_UPLOAD_MAX_BYTES,
      fieldSize: 512,
      fieldNameSize: 64,
    },
  });

  app.post("/imports/statements", async (request, reply) => {
    const startedAt = performance.now();
    const tenantId = getTenantId();
    const input = await readStatementUpload(request);
    try {
      const result = await options.service.import(tenantId, input);
      request.log.info(
        {
          event: "statement_import_completed",
          batchId: result.batchId,
          tenantId,
          accountId: input.accountId,
          provider: result.provider,
          format: result.format,
          source: input.source,
          batchStatus: result.batchStatus,
          totalTransactions: result.totalTransactions,
          importedCount: result.importedCount,
          duplicateCount: result.duplicateCount,
          classificationFailedCount: result.classificationFailedCount,
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Statement import completed",
      );
      return reply.status(201).send(result);
    } catch (error) {
      request.log.warn(
        {
          event: "statement_import_failed",
          tenantId,
          accountId: input.accountId,
          format: input.format,
          source: input.source,
          errorCode: error instanceof StatementImportError
            ? error.code
            : "UNEXPECTED_ERROR",
          durationMs: Math.round(performance.now() - startedAt),
        },
        "Statement import failed",
      );
      throw error;
    }
  });
}
