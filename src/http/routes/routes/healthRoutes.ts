import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance) {
  const response = {
    status: "ok" as const,
    service: "copiloto-financeiro-backend",
  };

  app.get("/health", async () => response);
  app.get("/health/live", async () => response);
}
