import { z } from "zod";

export const accountContextSchema = z.enum(["PF" , 
    "PJ","MEI"]);

export const transactionDirectionSchema = z.enum(["INFLOW",
    "OUTFLOW"]);

export const categorySchema = z.string();

export const categoryTypeSchema = z.enum([
  "INCOME",
  "EXPENSE",
  "INVESTMENT",
  "TRANSFER",
  "ANY",
]);

export const transactionOperationTypeSchema = z.enum([
  "INCOME",
  "EXPENSE",
  "TRANSFER",
  "INVESTMENT",
  "ADJUSTMENT",
]);

export const transactionStatusSchema = z.enum([
  "POSTED",
  "PENDING",
  "SCHEDULED",
  "CANCELED",
]);

export const transactionDateSchema = z.
  iso
  .date({
    error: "Informe uma data válida no formato YYYY-MM-DD.",
  })
  .transform((value) => {
    return new Date(`${value}T00:00:00.000Z`);
  });

export const createTransactionBodySchema = z.strictObject({
  accountId: z.uuid({
    error: "accountId precisa ser um UUID válido.",
  }),

  transactionDate: transactionDateSchema,

  description: z
    .string({
      error: "A descrição precisa ser uma string.",
    })
    .trim()
    .min(1, {
      error: "A descrição é obrigatória.",
    })
    .max(255, {
      error: "A descrição pode ter no máximo 255 caracteres.",
    }),

  amount: z
    .number({
      error: "O valor precisa ser um número.",
    })
    .nonnegative({
      error: "O valor não pode ser negativo.",
    }),

  direction: transactionDirectionSchema,

  operationType: transactionOperationTypeSchema,

  primaryCategoryId: z
    .uuid({
      error: "primaryCategoryId precisa ser um UUID válido.",
    })
    .nullable()
    .optional(),

  projectId: z
    .uuid({
      error: "projectId precisa ser um UUID válido.",
    })
    .nullable()
    .optional(),

  notes: z
    .string()
    .trim()
    .max(2000, {
      error: "As observações podem ter no máximo 2000 caracteres.",
    })
    .nullable()
    .optional(),
});

export const transactionForReportSchema = z.object({
  id: z.string().uuid(),

  description: z.string(),

  amount: z.number(),

  date: z.date(),

  operationType: transactionOperationTypeSchema,

  category: categorySchema,

  accountContext: accountContextSchema,
});

export const updateTransactionSchema =
  createTransactionBodySchema 
    .partial()
    .refine(
        (body) => Object.keys(body).length> 0,
        {
          message: "Informe pelo menos um campo.",
        },
    );

export const transactionParamsSchema = z.object({
  id: z.string()
})

export const transactionIdParamsSchema = z.strictObject({
  id: z.uuid({
    error: "O ID da transação precisa ser um UUID válido.",
  })
});

export const reportQueryStringSchema = z.strictObject({
  month: z.coerce
    .number()
    .int()
    .min(1)
    .max(12),

  year: z.coerce
    .number()
    .int()
    .min(2000)
    .max(2100),

  accountId: z.uuid().optional(),
});

export const domainErrorCodeSchema = z.enum([
  "ACCOUNT_UNAVAILABLE",
  "TRANSACTION_NOT_FOUND",
  "INVALID_DIRECTION",
  "CATEGORY_UNAVAILABLE",
  "ACCOUNT_NOT_FOUND",
  "CATEGORY_NOT_FOUND",
  "PENDING_CLASSIFICATION_NOT_FOUND",
  "CLASSIFICATION_REVIEW_NOT_FOUND",
  "CLASSIFICATION_REVIEW_NOT_WAITING",
  "CLASSIFICATION_REVIEW_MESSAGE_CONFLICT",
  "MERCHANT_RULE_DATA_REQUIRED",
  "MERCHANT_RULE_ALREADY_EXISTS",
  "CLASSIFICATION_ALREADY_CONFIRMED",
  "INVALID_TRANSACTION_OPERATION",
  "TRANSACTION_ALREADY_EXISTS",
]);
