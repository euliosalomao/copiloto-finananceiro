import type { FastifyInstance } from "fastify";
import { updateTransactionSchema, transactionIdParamsSchema } from "../../../core/schemas/zod.js";
import { TransactionParams } from "../../../core/schemas/types.js";
import { updateTransaction } from "../../../services/transactionServices.js"
import { getTenantId } from "../auth/getTenantId.js";

export async function updateTransactionRoute(app: FastifyInstance) {
    app.patch<{
        Params: TransactionParams; }>("/transactions/:id", 
            async (request,reply) => {
                const tenantId = getTenantId();

                const { id } = transactionIdParamsSchema.parse(request.params);

                const input = updateTransactionSchema.parse(request.body);

                const update = await updateTransaction(
                    tenantId,
                    id,
                    input,
                );
                
                return reply.status(200).send({
                    update
                });
    });
};
