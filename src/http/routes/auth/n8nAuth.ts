import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const publicPaths = new Set(["/health", "/health/live"]);

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function isValidBearerToken(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (!authorization?.startsWith("Bearer ")) return false;
  const receivedToken = authorization.slice("Bearer ".length);
  if (!receivedToken) return false;
  return timingSafeEqual(digest(receivedToken), digest(expectedToken));
}

export function registerN8nAuth(
  app: FastifyInstance,
  expectedToken: string,
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?", 1)[0]!;
    if (publicPaths.has(path)) return;

    if (isValidBearerToken(request.headers.authorization, expectedToken)) {
      return;
    }

    request.log.warn(
      { event: "n8n_authentication_failed", method: request.method },
      "Rejected unauthenticated backend request",
    );
    return reply
      .header("www-authenticate", "Bearer")
      .status(401)
      .send({
        error: "UNAUTHORIZED",
        message: "Credencial de integração inválida.",
      });
  });
}
