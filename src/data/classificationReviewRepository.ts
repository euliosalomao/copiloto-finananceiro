import { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../lib/prisma.js";

const CLAIM_LEASE_MS = 15 * 60 * 1000;

const reviewSelect = {
  id: true,
  tenant_id: true,
  classification_id: true,
  status: true,
  external_message_id: true,
  reply_message: true,
  resolved_category_id: true,
  claimed_at: true,
  claim_expires_at: true,
  message_sent_at: true,
  resolved_at: true,
  created_at: true,
  updated_at: true,
  categories: {
    select: {
      id: true,
      name: true,
      category_type: true,
    },
  },
  transaction_classifications: {
    select: {
      id: true,
      transaction_id: true,
      status: true,
      classified_by: true,
      category_id: true,
      confidence_score: true,
      reasoning: true,
      categories: {
        select: {
          id: true,
          name: true,
          category_type: true,
        },
      },
      transactions: {
        select: {
          id: true,
          description: true,
          amount: true,
          transaction_date: true,
          direction: true,
          operation_type: true,
          accounts: {
            select: {
              id: true,
              name: true,
              account_context: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.classification_reviewsSelect;

export type ClassificationReviewRecord =
  Prisma.classification_reviewsGetPayload<{ select: typeof reviewSelect }>;

export type ClaimNextReviewResult =
  | { kind: "READY"; review: ClassificationReviewRecord; reclaimed: boolean }
  | { kind: "WAITING_REPLY" | "CLAIM_IN_PROGRESS" | "EMPTY" };

export type AttachReviewMessageResult =
  | { kind: "ATTACHED"; review: ClassificationReviewRecord }
  | { kind: "NOT_FOUND" }
  | { kind: "NOT_CLAIMED" }
  | { kind: "MESSAGE_CONFLICT" };

export type ClassificationReviewRepository = {
  claimNext(tenantId: string): Promise<ClaimNextReviewResult>;
  attachMessage(
    tenantId: string,
    reviewId: string,
    externalMessageId: string,
  ): Promise<AttachReviewMessageResult>;
  findByExternalMessage(
    tenantId: string,
    externalMessageId: string,
  ): Promise<ClassificationReviewRecord | null>;
};

async function reviewById(
  client: Prisma.TransactionClient,
  tenantId: string,
  reviewId: string,
) {
  return client.classification_reviews.findFirst({
    where: { id: reviewId, tenant_id: tenantId },
    select: reviewSelect,
  });
}

export const classificationReviewRepository: ClassificationReviewRepository = {
  claimNext(tenantId: string): Promise<ClaimNextReviewResult> {
    return prisma.$transaction(async (tx) => {
      // A linha do tenant funciona como mutex transacional. Duas execuções do
      // schedule não conseguem criar duas reviews ativas para o mesmo tenant.
      const tenant = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT id
        FROM tenants
        WHERE id = ${tenantId}::uuid
        FOR UPDATE
      `);
      if (!tenant.length) return { kind: "EMPTY" };

      const now = new Date();
      const active = await tx.classification_reviews.findFirst({
        where: {
          tenant_id: tenantId,
          status: { in: ["CLAIMED", "WAITING_REPLY"] },
        },
        orderBy: { created_at: "asc" },
        select: reviewSelect,
      });

      if (active?.status === "WAITING_REPLY") {
        return { kind: "WAITING_REPLY" };
      }
      if (
        active?.status === "CLAIMED" &&
        active.claim_expires_at &&
        active.claim_expires_at > now
      ) {
        return { kind: "CLAIM_IN_PROGRESS" };
      }
      if (active?.status === "CLAIMED") {
        const claimExpiresAt = new Date(now.getTime() + CLAIM_LEASE_MS);
        await tx.classification_reviews.update({
          where: { id: active.id },
          data: {
            claimed_at: now,
            claim_expires_at: claimExpiresAt,
            updated_at: now,
          },
        });
        const reclaimed = await reviewById(tx, tenantId, active.id);
        if (!reclaimed) throw new Error("Review reivindicada não foi encontrada.");
        return { kind: "READY", review: reclaimed, reclaimed: true };
      }

      const candidate = await tx.transaction_classifications.findFirst({
        where: {
          tenant_id: tenantId,
          status: "PENDING_REVIEW",
          classified_by: "AI",
          category_id: { not: null },
          classification_reviews: null,
        },
        orderBy: [
          { created_at: "asc" },
          { id: "asc" },
        ],
        select: { id: true },
      });
      if (!candidate) return { kind: "EMPTY" };

      const review = await tx.classification_reviews.create({
        data: {
          tenant_id: tenantId,
          classification_id: candidate.id,
          status: "CLAIMED",
          claimed_at: now,
          claim_expires_at: new Date(now.getTime() + CLAIM_LEASE_MS),
        },
        select: reviewSelect,
      });
      return { kind: "READY", review, reclaimed: false };
    });
  },

  attachMessage(
    tenantId: string,
    reviewId: string,
    externalMessageId: string,
  ): Promise<AttachReviewMessageResult> {
    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT id
        FROM classification_reviews
        WHERE id = ${reviewId}::uuid
          AND tenant_id = ${tenantId}::uuid
        FOR UPDATE
      `);
      const current = await reviewById(tx, tenantId, reviewId);
      if (!current) return { kind: "NOT_FOUND" };
      if (current.status === "WAITING_REPLY") {
        return current.external_message_id === externalMessageId
          ? { kind: "ATTACHED", review: current }
          : { kind: "MESSAGE_CONFLICT" };
      }
      if (current.status !== "CLAIMED") return { kind: "NOT_CLAIMED" };

      const sentAt = new Date();
      try {
        const review = await tx.classification_reviews.update({
          where: { id: current.id },
          data: {
            status: "WAITING_REPLY",
            external_message_id: externalMessageId,
            claim_expires_at: null,
            message_sent_at: sentAt,
            updated_at: sentAt,
          },
          select: reviewSelect,
        });
        return { kind: "ATTACHED", review };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          return { kind: "MESSAGE_CONFLICT" };
        }
        throw error;
      }
    });
  },

  findByExternalMessage(tenantId: string, externalMessageId: string) {
    return prisma.classification_reviews.findFirst({
      where: {
        tenant_id: tenantId,
        external_message_id: externalMessageId,
      },
      select: reviewSelect,
    });
  },
};
