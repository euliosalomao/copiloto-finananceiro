import type { FastifyInstance } from "fastify";
import { transactionIdParamsSchema } from "../../../core/schemas/zod.js"
import { getTransactionById } from "../../../services/transactionServices.js"
import { getTenantId } from "../auth/getTenantId.js";

export async function getTransactionByIdRoute(app: FastifyInstance) {
    app.get("/transactions/:id" , async (request,reply) => {
        const {id} = transactionIdParamsSchema.parse(request.params)
        const tenantId = getTenantId();

        const transaction = await getTransactionById(tenantId,id);
        
        return { transaction };
    });
}
