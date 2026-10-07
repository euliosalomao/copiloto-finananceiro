import type { FastifyInstance } from "fastify";
import { TransactionParams } from "../../../core/schemas/types.js";
import { transactionIdParamsSchema } from "../../../core/schemas/zod.js";
import { deleteTransaction } from "../../../services/transactionServices.js"
import { getTenantId } from "../auth/getTenantId.js";


export async function deleteTransactionRoute(app: FastifyInstance) {
    app.delete<{
        Params: TransactionParams; }>("/transactions/:id",
            async (request,reply) => {
                const tenantId = getTenantId();

                const { id } =
                transactionIdParamsSchema.parse(
                    request.params,
                );

                await deleteTransaction(
                    tenantId,
                    id,
                );

                return reply.status(204).send();
    });
};
