import type { FastifyInstance } from "fastify";
import { findTransactionsForReport } from "../../../data/transactionsRepository.js";
import { generateMonthlyReport } from "../../../core/report.js";
import { reportQueryStringSchema } from "../../../core/schemas/zod.js";
import type { ReportQueryString } from "../../../core/schemas/types.js";
import { getTenantId } from "../auth/getTenantId.js";


export async function reportRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: ReportQueryString;
  }>("/report", async (request, reply) => {
    const { month, year, accountId } = reportQueryStringSchema.parse(request.query);
    const tenantId = getTenantId();

    const transactions = await findTransactionsForReport(tenantId, { month, year, accountId });
    const report = generateMonthlyReport(transactions);

    return reply.status(200).send({
      period: { month, year },
      accountId: accountId ?? null,
      report,
    });
  });
}
