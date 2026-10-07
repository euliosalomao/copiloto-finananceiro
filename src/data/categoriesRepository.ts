import { prisma } from "../lib/prisma.js";
import type { CreateCategoryInput } from "../core/schemas/types.js";

export async function findActiveByTenant(tenantId: string) {
  return prisma.categories.findMany({
    where: {
      tenant_id: tenantId,
      is_active: true,
    },
    select: {
      id: true,
      name: true,
      parent_id: true,
      category_type: true,
      description: true,
    },
    orderBy: [
      { category_type: "asc" },
      { name: "asc" },
    ],
  });
}

export async function findById(tenantId:string , categoryId: string){
  const category = prisma.categories.findFirst({
    where: {
      tenant_id: tenantId,
      id: categoryId,
      is_active: true,
    },

    select: {
      id: true,
    },
  });

  return category;
}

export async function createCategory(
  tenantId: string,
  input: CreateCategoryInput,
) {
  return prisma.categories.create({
    data: {
      tenant_id: tenantId,
      name: input.name,
      category_type: input.categoryType,
      parent_id: input.parentId ?? null,
      description: input.description ?? null,
    },
    select: {
      id: true,
      name: true,
      parent_id: true,
      category_type: true,
      description: true,
    },
  });
}
