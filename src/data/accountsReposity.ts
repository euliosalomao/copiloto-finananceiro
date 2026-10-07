import { prisma } from "../lib/prisma.js";

export async function findActiveByTenant(
  tenantId: string,
) {
  return prisma.accounts.findMany({
    where: {
      tenant_id: tenantId,
      is_active: true,
    },
    select: {
      id: true,
      name: true,
      institution: true,
      account_context: true,
      account_type: true,
      currency: true,
      provider: true,
    },
    orderBy: [
      { account_context: "asc" },
      { name: "asc" },
    ],
  });
}

export async function findActiveAccountForTenant(tenantId: string , accountId: string){
  return await prisma.accounts.findFirst({
    where: {
      id: accountId,
      tenant_id: tenantId,
      is_active: true,
    },
    select:{
      id: true,
    }
  });
};
