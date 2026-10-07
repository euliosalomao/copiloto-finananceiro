import { z } from "zod";

export const transactionIdParamsSchema = z.object({
  transactionId: z.string().uuid(),
});

export const merchantRuleInputSchema = z.strictObject({
  pattern: z
    .string()
    .trim()
    .min(2)
    .max(200),
  matchType: z.enum([
    "EXACT",
    "CONTAINS",
  ]),
});

export const confirmClassificationBodySchema =
  z
    .object({
      categoryId: z.string().uuid(),

      createMerchantRule: z
        .boolean()
        .default(false),

      merchantRule: merchantRuleInputSchema.optional(),
    })
    .superRefine((input, ctx) => {
      if (
        input.createMerchantRule &&
        !input.merchantRule
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["merchantRule"],
          message:
            "merchantRule is required when createMerchantRule is true",
        });
      }
    });

export type ConfirmClassificationInput =
  z.infer<
    typeof confirmClassificationBodySchema
  >;
