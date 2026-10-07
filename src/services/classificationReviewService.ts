import { DomainError } from "../core/errors.js";
import type { ConfirmClassificationInput } from "../core/schemas/types.js";
import {
  classificationReviewRepository,
  type ClassificationReviewRecord,
  type ClassificationReviewRepository,
} from "../data/classificationReviewRepository.js";
import { confirmClassificationForReview } from "./classificationService.js";

export type ClassificationReviewReplyInput = {
  quotedMessageId: string;
  message: string;
  action: "ACCEPT_SUGGESTION" | "CHANGE_CATEGORY";
  categoryId?: string;
  createMerchantRule: boolean;
  merchantRule?: {
    pattern: string;
    matchType: "EXACT" | "CONTAINS";
  };
};

type ConfirmReview = (
  tenantId: string,
  transactionId: string,
  input: ConfirmClassificationInput,
  resolution: { reviewId: string; replyMessage: string },
) => Promise<{
  status: "CONFIRMED";
  transactionId: string;
  categoryId: string;
  merchantRuleCreated: boolean;
  merchantRuleId: string | null;
}>;

type Dependencies = {
  reviews: Pick<
    ClassificationReviewRepository,
    "claimNext" | "attachMessage" | "findByExternalMessage"
  >;
  confirmReview: ConfirmReview;
};

function reviewPayload(review: ClassificationReviewRecord) {
  const classification = review.transaction_classifications;
  const transaction = classification.transactions;
  const suggestion = classification.categories;
  if (!suggestion) {
    throw new Error("Review sem categoria sugerida pela IA.");
  }

  return {
    reviewId: review.id,
    status: review.status,
    reclaimed: false,
    claimExpiresAt: review.claim_expires_at,
    transaction: {
      id: transaction.id,
      description: transaction.description,
      amount: transaction.amount.toFixed(2),
      transactionDate: transaction.transaction_date.toISOString().slice(0, 10),
      direction: transaction.direction,
      operationType: transaction.operation_type,
      account: {
        id: transaction.accounts.id,
        name: transaction.accounts.name,
        context: transaction.accounts.account_context,
      },
    },
    suggestion: {
      categoryId: suggestion.id,
      categoryName: suggestion.name,
      categoryType: suggestion.category_type,
      confidence: classification.confidence_score === null
        ? null
        : Number(classification.confidence_score),
      reasoning: classification.reasoning,
    },
  };
}

export function createClassificationReviewService(dependencies: Dependencies) {
  async function claimNext(tenantId: string) {
    const result = await dependencies.reviews.claimNext(tenantId);
    if (result.kind !== "READY") {
      return { queueState: result.kind, review: null };
    }

    return {
      queueState: "READY" as const,
      review: {
        ...reviewPayload(result.review),
        reclaimed: result.reclaimed,
      },
    };
  }

  return {
    claimNext,

    async attachMessage(
      tenantId: string,
      reviewId: string,
      externalMessageId: string,
    ) {
      const result = await dependencies.reviews.attachMessage(
        tenantId,
        reviewId,
        externalMessageId,
      );
      if (result.kind === "NOT_FOUND") {
        throw new DomainError(
          "CLASSIFICATION_REVIEW_NOT_FOUND",
          "Revisão de classificação não encontrada.",
        );
      }
      if (result.kind === "MESSAGE_CONFLICT") {
        throw new DomainError(
          "CLASSIFICATION_REVIEW_MESSAGE_CONFLICT",
          "A mensagem já pertence a outra revisão ou a revisão já possui outra mensagem.",
        );
      }
      if (result.kind === "NOT_CLAIMED") {
        throw new DomainError(
          "CLASSIFICATION_REVIEW_NOT_WAITING",
          "A revisão não está aguardando o envio da mensagem.",
        );
      }

      return {
        reviewId: result.review.id,
        status: "WAITING_REPLY" as const,
        externalMessageId: result.review.external_message_id,
        messageSentAt: result.review.message_sent_at,
      };
    },

    async reply(tenantId: string, input: ClassificationReviewReplyInput) {
      const review = await dependencies.reviews.findByExternalMessage(
        tenantId,
        input.quotedMessageId,
      );
      if (!review) {
        throw new DomainError(
          "CLASSIFICATION_REVIEW_NOT_FOUND",
          "Nenhuma revisão corresponde à mensagem respondida.",
        );
      }

      if (review.status === "RESOLVED") {
        return {
          resolved: {
            reviewId: review.id,
            transactionId:
              review.transaction_classifications.transaction_id,
            categoryId: review.resolved_category_id,
            merchantRuleCreated: false,
            merchantRuleId: null,
            alreadyResolved: true,
          },
          queueState: "ALREADY_RESOLVED" as const,
          next: null,
        };
      }
      if (review.status !== "WAITING_REPLY") {
        throw new DomainError(
          "CLASSIFICATION_REVIEW_NOT_WAITING",
          "A revisão ainda não está aguardando resposta.",
        );
      }

      const suggestedCategoryId =
        review.transaction_classifications.category_id;
      const categoryId = input.action === "ACCEPT_SUGGESTION"
        ? suggestedCategoryId
        : input.categoryId;
      if (!categoryId) {
        throw new DomainError(
          "CATEGORY_NOT_FOUND",
          "A categoria escolhida não foi encontrada.",
        );
      }

      const confirmed = await dependencies.confirmReview(
        tenantId,
        review.transaction_classifications.transaction_id,
        {
          categoryId,
          createMerchantRule: input.createMerchantRule,
          ...(input.merchantRule && { merchantRule: input.merchantRule }),
        },
        { reviewId: review.id, replyMessage: input.message },
      );
      const next = await claimNext(tenantId);

      return {
        resolved: {
          reviewId: review.id,
          transactionId: confirmed.transactionId,
          categoryId: confirmed.categoryId,
          merchantRuleCreated: confirmed.merchantRuleCreated,
          merchantRuleId: confirmed.merchantRuleId,
          alreadyResolved: false,
        },
        queueState: next.queueState,
        next: next.review,
      };
    },
  };
}

export const classificationReviewService = createClassificationReviewService({
  reviews: classificationReviewRepository,
  confirmReview: confirmClassificationForReview,
});
