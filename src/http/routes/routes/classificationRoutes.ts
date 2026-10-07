import type {
  FastifyInstance,
} from "fastify";

import * as classificationService from
  "../../../services/classificationService.js";

import {
  confirmClassificationBodySchema,
  transactionIdParamsSchema,
} from "../schemas/classificationHttpSchemas.js";

import { getTenantId } from
  "../auth/getTenantId.js";

export async function classificationRoutes(
  app: FastifyInstance,
) {
  /*
   * Classifica uma transação
   */
  app.post(
    "/transactions/:transactionId/classify",
    async (request, reply) => {
      const tenantId = getTenantId();

      const { transactionId } =
        transactionIdParamsSchema.parse(
          request.params,
        );

      const result =
        await classificationService
          .classifyTransaction(
            tenantId,
            transactionId,
          );

      return reply.status(200).send(result);
    },
  );

  /*
   * Lista pendências
   */
  app.get(
    "/classifications/pending",
    async (request, reply) => {
      const tenantId = getTenantId();

      const result =
        await classificationService
          .getPendingClassifications(
            tenantId,
          );

      return reply.status(200).send(result);
    },
  );

  /*
   * Confirma uma classificação
   */
  app.post(
    "/transactions/:transactionId/classification/confirm",
    async (request, reply) => {
      const tenantId = getTenantId();

      const { transactionId } =
        transactionIdParamsSchema.parse(
          request.params,
        );

      const input =
        confirmClassificationBodySchema.parse(
          request.body,
        );

      const result =
        await classificationService
          .confirmClassification(
            tenantId,
            transactionId,
            input,
          );

      return reply.status(200).send(result);
    },
  );
}
