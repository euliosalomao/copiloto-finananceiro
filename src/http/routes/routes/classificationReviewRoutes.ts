import type { FastifyInstance } from "fastify";
import { classificationReviewService } from
  "../../../services/classificationReviewService.js";
import { getTenantId } from "../auth/getTenantId.js";
import {
  attachClassificationReviewMessageSchema,
  classificationReviewIdParamsSchema,
  classificationReviewReplySchema,
} from "../schemas/classificationReviewHttpSchemas.js";

export async function classificationReviewRoutes(app: FastifyInstance) {
  app.post("/classification-reviews/next", async (_request, reply) => {
    const result = await classificationReviewService.claimNext(getTenantId());
    return reply.status(200).send(result);
  });

  app.patch(
    "/classification-reviews/:reviewId/message",
    async (request, reply) => {
      const { reviewId } = classificationReviewIdParamsSchema.parse(
        request.params,
      );
      const { externalMessageId } =
        attachClassificationReviewMessageSchema.parse(request.body);
      const result = await classificationReviewService.attachMessage(
        getTenantId(),
        reviewId,
        externalMessageId,
      );
      return reply.status(200).send(result);
    },
  );

  app.post("/classification-reviews/reply", async (request, reply) => {
    const input = classificationReviewReplySchema.parse(request.body);
    const result = await classificationReviewService.reply(
      getTenantId(),
      input,
    );
    return reply.status(200).send(result);
  });
}
