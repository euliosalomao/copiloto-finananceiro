import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { CSV_MAX_BYTES, CsvImportError } from "../../../core/csvImport.js";
import type { CsvImportService } from "../../../services/importService.js";
import { getTenantId } from "../auth/getTenantId.js";

const fieldsSchema = z.strictObject({
  accountId: z.uuid().transform((value) => value.toLowerCase()),
  previewToken: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  // FormData envia texto. z.coerce.boolean() interpretaria "false" como true.
  allowPossibleDuplicates: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
});

async function readUpload(request: FastifyRequest) {
  if (!request.isMultipart()) {
    throw new CsvImportError("CSV_MULTIPART_REQUIRED", "Envie multipart/form-data com accountId e file.", 415);
  }
  const fields: Record<string, string> = {};
  let file: Buffer | undefined;
  let interrupted = false;

  // Lê todas as partes; funciona mesmo quando accountId vem depois do arquivo.
  for await (const part of request.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "file" || !part.filename.toLowerCase().endsWith(".csv")) {
        part.file.resume();
        throw new CsvImportError("CSV_FILE_REQUIRED", "Use o campo file para enviar um arquivo .csv.");
      }
      try {
        file = await part.toBuffer();
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_STREAM_PREMATURE_CLOSE") throw error;
        // Um limite de partes/arquivos pode fechar o stream antes do toBuffer.
        // Continue o iterador para receber o erro 413 original do multipart.
        interrupted = true;
      }
    } else {
      if (part.fieldnameTruncated || part.valueTruncated) {
        throw new CsvImportError("CSV_FIELD_TOO_LARGE", "Campo multipart excedeu o limite.", 413);
      }
      if (Object.hasOwn(fields, part.fieldname) || typeof part.value !== "string") {
        throw new CsvImportError("CSV_FIELDS", "Não repita campos multipart; envie valores em texto.");
      }
      Object.defineProperty(fields, part.fieldname, { value: part.value, enumerable: true });
    }
  }
  if (interrupted) throw new CsvImportError("CSV_UPLOAD_INCOMPLETE", "Upload interrompido. Envie o arquivo novamente.");
  if (!file) throw new CsvImportError("CSV_FILE_REQUIRED", "Envie um arquivo no campo file.");
  return { ...fieldsSchema.parse(fields), file };
}

export async function importRoutes(
  app: FastifyInstance,
  options: { service: CsvImportService },
) {
  await app.register(multipart, {
    limits: { files: 1, fields: 3, parts: 4, fileSize: CSV_MAX_BYTES, fieldSize: 128, fieldNameSize: 64 },
  });

  app.post("/imports/csv/preview", async (request, reply) => {
    const tenantId = getTenantId();
    const input = await readUpload(request);
    return reply.status(200).send(await options.service.preview(tenantId, input));
  });

  app.post("/imports/csv", async (request, reply) => {
    const tenantId = getTenantId();
    const input = await readUpload(request);
    if (!input.previewToken) {
      throw new CsvImportError("CSV_PREVIEW_REQUIRED", "Gere o preview e envie o previewToken antes de importar.");
    }
    return reply.status(201).send(await options.service.commit(tenantId, { ...input, previewToken: input.previewToken }));
  });
}
