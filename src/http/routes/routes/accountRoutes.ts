import type { FastifyInstance } from "fastify";

import * as accountService from
  "../../../services/accountService.js";
import { getTenantId } from "../auth/getTenantId.js";

export async function accountRoutes(
  app: FastifyInstance,
) {
  app.get("/accounts", async (_request, reply) => {
    const tenantId = getTenantId();
    const accounts =
      await accountService.getAccounts(tenantId);

    return reply.status(200).send({ accounts });
  });
}
