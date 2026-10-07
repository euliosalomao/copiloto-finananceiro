import { z } from "zod";

const tenantIdSchema = z.string().uuid();

export function getTenantId(): string {
  const result = tenantIdSchema.safeParse(
    process.env.DEFAULT_TENANT_ID,
  );

  if (!result.success) {
    throw new Error(
      "DEFAULT_TENANT_ID não configurado ou inválido.",
    );
  }

  return result.data;
}
