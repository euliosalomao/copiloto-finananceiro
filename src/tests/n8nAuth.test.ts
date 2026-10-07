import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import {
  isValidBearerToken,
  registerN8nAuth,
} from "../http/routes/auth/n8nAuth.js";

const token = "test-token-with-at-least-thirty-two-characters";

test("valida o bearer token sem aceitar prefixos ou token vazio", () => {
  assert.equal(isValidBearerToken(`Bearer ${token}`, token), true);
  assert.equal(isValidBearerToken(`bearer ${token}`, token), false);
  assert.equal(isValidBearerToken(`Bearer ${token}-extra`, token), false);
  assert.equal(isValidBearerToken("Bearer ", token), false);
  assert.equal(isValidBearerToken(undefined, token), false);
});

test("protege a API e mantém somente o healthcheck público", async (t) => {
  const app = Fastify({ logger: false });
  registerN8nAuth(app, token);
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/private", async () => ({ status: "ok" }));
  t.after(() => app.close());

  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);

  const unauthenticated = await app.inject({ method: "GET", url: "/private" });
  assert.equal(unauthenticated.statusCode, 401);
  assert.equal(unauthenticated.headers["www-authenticate"], "Bearer");

  const authenticated = await app.inject({
    method: "GET",
    url: "/private",
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(authenticated.statusCode, 200);
});
