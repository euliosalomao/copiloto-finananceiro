import { z } from "zod";

const serverConfigSchema = z.object({
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3333),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]).default("info"),
  N8N_API_TOKEN: z.string().min(32),
  DEFAULT_TENANT_ID: z.string().uuid(),
  DATABASE_URL: z.string().trim().min(1),
  OPENAI_API_KEY: z.string().trim().min(1),
  OPENAI_CLASSIFICATION_MODEL: z.string().trim().min(1).default("gpt-4o-mini"),
});

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const result = serverConfigSchema.safeParse(environment);
  if (result.success) return result.data;

  const fields = [...new Set(
    result.error.issues.map((issue) => issue.path.join(".") || "environment"),
  )];
  throw new Error(
    `Configuração inválida ou ausente: ${fields.join(", ")}.`,
  );
}
