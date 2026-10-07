import type { FastifyInstance } from "fastify";
import { createTransactionBodySchema } from "../../../core/schemas/zod.js";
import { createTransaction } from "../../../services/transactionServices.js"
import { getTenantId } from "../auth/getTenantId.js";

export async function createTransactionRoute(app: FastifyInstance) {
    app.post("/transactions", async (request,reply) => {
        const tenantId = getTenantId();

        const body = createTransactionBodySchema.parse(request.body);

        const transaction = await createTransaction(
            tenantId,
            body,
        );

        return reply.status(201).send({
            transaction,
        });
    });
};
