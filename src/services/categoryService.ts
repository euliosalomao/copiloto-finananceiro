import type {
  CreateCategoryInput,
} from "../core/schemas/types.js";

import { DomainError } from "../core/errors.js";
import * as categoriesRepository from
  "../data/categoriesRepository.js";

export async function getCategories(
  tenantId: string,
) {
  return categoriesRepository.findActiveByTenant(
    tenantId,
  );
}

export async function createCategory(
  tenantId: string,
  input: CreateCategoryInput,
) {
  if (input.parentId) {
    const parent = await categoriesRepository.findById(
      tenantId,
      input.parentId,
    );

    if (!parent) {
      throw new DomainError(
        "CATEGORY_UNAVAILABLE",
        "Categoria pai não encontrada ou indisponível.",
      );
    }
  }

  return categoriesRepository.createCategory(
    tenantId,
    input,
  );
}
