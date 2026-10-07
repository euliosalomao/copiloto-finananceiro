import { z } from "zod";

import { categoryTypeSchema } from
  "../../../core/schemas/zod.js";

export const createCategoryBodySchema =
  z.strictObject({
    name: z
      .string()
      .trim()
      .min(1, "O nome da categoria é obrigatório.")
      .max(100, "O nome pode ter no máximo 100 caracteres."),

    categoryType: categoryTypeSchema,

    parentId: z
      .uuid("parentId precisa ser um UUID válido.")
      .nullable()
      .optional(),

    description: z
      .string()
      .trim()
      .max(500, "A descrição pode ter no máximo 500 caracteres.")
      .nullable()
      .optional(),
  });
