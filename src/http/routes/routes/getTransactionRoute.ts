import type { FastifyInstance } from "fastify";
import { getTransactions } from "../../../services/transactionServices.js"
import { getTenantId } from "../auth/getTenantId.js";

export async function getTransactionsRoute (app: FastifyInstance) {
    app.get("/transactions" , async () => {
        const tenantId = getTenantId();
        const transaction = await getTransactions(tenantId)
        
        return transaction;
    });
}
