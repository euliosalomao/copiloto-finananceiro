import type { FastifyInstance } from "fastify";

import * as categoryService from
  "../../../services/categoryService.js";
import { getTenantId } from "../auth/getTenantId.js";
import { createCategoryBodySchema } from
  "../schemas/categoryHttpSchemas.js";

export async function categoryRoutes(
  app: FastifyInstance,
) {
  app.get("/categories", async (_request, reply) => {
    const tenantId = getTenantId();
    const categories =
      await categoryService.getCategories(tenantId);

    return reply.status(200).send({ categories });
  });

  app.post("/categories", async (request, reply) => {
    const tenantId = getTenantId();
    const input = createCategoryBodySchema.parse(
      request.body,
    );
    const category =
      await categoryService.createCategory(
        tenantId,
        input,
      );

    return reply.status(201).send({ category });
  });
}
