import type { PrismaClient } from "../../src/generated/prisma/client";

export async function resetIntegrationDatabase(database: PrismaClient) {
  await database.$executeRawUnsafe(`
    TRUNCATE TABLE
      "WorkerHeartbeat",
      "Verification",
      "Session",
      "Account",
      "Membership",
      "FinancialOutbox",
      "FinancialLedgerEntry",
      "PaymentDisputeEvent",
      "PaymentDispute",
      "RefundAttempt",
      "RefundSeat",
      "Refund",
      "PaymentWebhookEvent",
      "BookingSeat",
      "Booking",
      "PaymentAttempt",
      "CheckoutOrderItem",
      "CheckoutOrder",
      "InventoryEventOutbox",
      "InventoryOperationsMetric",
      "SeatHoldItem",
      "SeatHold",
      "SessionSeatInventory",
      "SessionSectionPricing",
      "SessionPriceTier",
      "EventSession",
      "Event",
      "VenueAccessGrant",
      "Seat",
      "SeatRow",
      "SeatSection",
      "SeatMap",
      "Space",
      "Venue",
      "Organization",
      "User"
    RESTART IDENTITY CASCADE
  `);
}
