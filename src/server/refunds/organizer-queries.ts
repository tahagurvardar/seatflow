import type { PrismaClient } from "@/generated/prisma/client";
import type { SupportedCurrency } from "@/config/site";
import { detectRefundDisputeOverlap } from "@/features/disputes/lifecycle";
import { findAuthorizedOrganizationMembership } from "@/server/authorization/organization-membership";

/**
 * Organization-scoped financial summaries for organizers.
 *
 * Organization access is resolved from the authenticated actor's membership,
 * never from a client-supplied organization id. Every query below is filtered
 * by the organization id that lookup returned, so there is no code path that
 * can read another tenant's refunds or disputes even if a slug is guessed.
 *
 * What is deliberately absent: customer identity, provider identifiers, refund
 * and booking references, payment method data, webhook detail, and dispute
 * evidence. Organizers get aggregates and queue depths, which is what they need
 * to run their events, and nothing that would turn this into a customer-data
 * export.
 */

export class OrganizerFinancialAccessError extends Error {
  constructor() {
    super("That organization's financial summary is not available.");
    this.name = "OrganizerFinancialAccessError";
  }
}

export interface OrganizerFinancialSummary {
  organizationName: string;
  refunds: {
    awaitingReview: number;
    processing: number;
    succeeded: number;
    failedOrReview: number;
  };
  refundedByCurrency: Array<{ currency: SupportedCurrency; totalMinor: number }>;
  disputes: {
    open: number;
    lost: number;
    requiresReview: number;
    evidenceDueSoon: number;
  };
  disputedByCurrency: Array<{ currency: SupportedCurrency; totalMinor: number }>;
  ticketRevocationBacklog: number;
  financialReviewQueue: number;
  /** True when refunds and disputes touch the same money for this tenant. */
  refundDisputeOverlap: boolean;
}

export async function getOrganizerFinancialSummary(
  database: PrismaClient,
  scope: { userId: string; organizationSlug: string },
  now = new Date(),
): Promise<OrganizerFinancialSummary> {
  // Authorization first: everything below is scoped by what this returns.
  const membership = await findAuthorizedOrganizationMembership(database, {
    userId: scope.userId,
    organizationSlug: scope.organizationSlug,
    kind: "ORGANIZER",
    minimumRole: "MEMBER",
  });
  if (!membership) throw new OrganizerFinancialAccessError();

  const organizationId = membership.organization.id;
  const evidenceSoon = new Date(now.getTime() + 48 * 3_600_000);
  const organizationScopedRefund = { booking: { organizationId } };

  const [
    awaitingReview,
    processing,
    succeeded,
    failedOrReview,
    refundedByCurrency,
    open,
    lost,
    requiresReview,
    evidenceDueSoon,
    disputedByCurrency,
    ticketRevocationBacklog,
    financialReviewQueue,
    succeededRefundTotal,
    openDisputeTotal,
    capturedTotal,
  ] = await Promise.all([
    database.refund.count({ where: { ...organizationScopedRefund, status: "REQUESTED" } }),
    database.refund.count({
      where: { ...organizationScopedRefund, status: { in: ["SUBMITTING", "PROCESSING"] } },
    }),
    database.refund.count({ where: { ...organizationScopedRefund, status: "SUCCEEDED" } }),
    database.refund.count({
      where: { ...organizationScopedRefund, status: { in: ["FAILED", "REQUIRES_REVIEW"] } },
    }),
    database.refund.groupBy({
      by: ["currency"],
      where: { ...organizationScopedRefund, succeededAt: { not: null } },
      _sum: { requestedAmountMinor: true },
      orderBy: { currency: "asc" },
    }),
    database.paymentDispute.count({
      where: {
        order: { organizationId },
        status: { in: ["OPEN", "NEEDS_RESPONSE", "UNDER_REVIEW"] },
      },
    }),
    database.paymentDispute.count({ where: { order: { organizationId }, status: "LOST" } }),
    database.paymentDispute.count({
      where: { order: { organizationId }, status: "REQUIRES_REVIEW" },
    }),
    database.paymentDispute.count({
      where: {
        order: { organizationId },
        status: { in: ["OPEN", "NEEDS_RESPONSE", "UNDER_REVIEW"] },
        evidenceDueAt: { not: null, lte: evidenceSoon },
      },
    }),
    database.paymentDispute.groupBy({
      by: ["currency"],
      where: { order: { organizationId }, status: { notIn: ["WON"] } },
      _sum: { disputedAmountMinor: true },
      orderBy: { currency: "asc" },
    }),
    database.ticket.count({
      where: { organizationId, status: "ACTIVE", booking: { status: "REFUNDED" } },
    }),
    database.checkoutOrder.count({
      where: { organizationId, financialReviewState: { not: "NONE" } },
    }),
    database.refund.aggregate({
      where: { ...organizationScopedRefund, succeededAt: { not: null } },
      _sum: { requestedAmountMinor: true },
    }),
    database.paymentDispute.aggregate({
      where: { order: { organizationId }, status: { notIn: ["WON"] } },
      _sum: { disputedAmountMinor: true },
    }),
    database.booking.aggregate({ where: { organizationId }, _sum: { totalMinor: true } }),
  ]);

  const overlap = detectRefundDisputeOverlap({
    succeededRefundMinor: succeededRefundTotal._sum.requestedAmountMinor ?? 0,
    disputedAmountMinor: openDisputeTotal._sum.disputedAmountMinor ?? 0,
    capturedMinor: capturedTotal._sum.totalMinor ?? 0,
  });

  return {
    organizationName: membership.organization.name,
    refunds: { awaitingReview, processing, succeeded, failedOrReview },
    refundedByCurrency: refundedByCurrency.map((row) => ({
      currency: row.currency,
      totalMinor: row._sum.requestedAmountMinor ?? 0,
    })),
    disputes: { open, lost, requiresReview, evidenceDueSoon },
    disputedByCurrency: disputedByCurrency.map((row) => ({
      currency: row.currency,
      totalMinor: row._sum.disputedAmountMinor ?? 0,
    })),
    ticketRevocationBacklog,
    financialReviewQueue,
    refundDisputeOverlap: overlap.overlapping,
  };
}
