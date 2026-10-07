import { z } from "zod";
import { merchantRuleInputSchema } from "./classificationHttpSchemas.js";

export const classificationReviewIdParamsSchema = z.strictObject({
  reviewId: z.uuid(),
});

export const attachClassificationReviewMessageSchema = z.strictObject({
  externalMessageId: z.string().trim().min(1).max(512),
});

export const classificationReviewReplySchema = z.strictObject({
  quotedMessageId: z.string().trim().min(1).max(512),
  message: z.string().trim().min(1).max(500),
  action: z.enum(["ACCEPT_SUGGESTION", "CHANGE_CATEGORY"]),
  categoryId: z.uuid().optional(),
  createMerchantRule: z.boolean().default(false),
  merchantRule: merchantRuleInputSchema.optional(),
}).superRefine((input, ctx) => {
  if (input.action === "CHANGE_CATEGORY" && !input.categoryId) {
    ctx.addIssue({
      code: "custom",
      path: ["categoryId"],
      message: "categoryId é obrigatório ao trocar a categoria.",
    });
  }
  if (input.action === "ACCEPT_SUGGESTION" && input.categoryId) {
    ctx.addIssue({
      code: "custom",
      path: ["categoryId"],
      message: "categoryId não deve ser enviado ao aceitar a sugestão.",
    });
  }
  if (input.createMerchantRule && !input.merchantRule) {
    ctx.addIssue({
      code: "custom",
      path: ["merchantRule"],
      message: "merchantRule é obrigatório quando createMerchantRule é true.",
    });
  }
});
