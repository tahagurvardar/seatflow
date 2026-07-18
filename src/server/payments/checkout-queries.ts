import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { SupportedCurrency } from "@/config/site";
import { toCheckoutDisplayState } from "@/features/checkout/view-models";
import { CheckoutAuthorizationError } from "@/server/payments/errors";

export const checkoutViewInclude = {
  event: { select: { title: true, publicSlug: true } },
  session: {
    include: {
      venue: { select: { name: true, city: true, timeZone: true } },
      space: { select: { name: true } },
    },
  },
  items: { orderBy: [{ sectionCode: "asc" }, { rowLabel: "asc" }, { seatLabel: "asc" }] },
  paymentAttempts: { orderBy: { createdAt: "desc" }, take: 1 },
  booking: { select: { publicReference: true, status: true } },
} satisfies Prisma.CheckoutOrderInclude;

type CheckoutWithView = Prisma.CheckoutOrderGetPayload<{
  include: typeof checkoutViewInclude;
}>;

export interface CustomerCheckoutView {
  publicReference: string;
  status: CheckoutWithView["status"];
  displayState: ReturnType<typeof toCheckoutDisplayState>;
  currency: SupportedCurrency;
  subtotalMinor: number;
  totalMinor: number;
  checkoutExpiresAt: string;
  paidAt: string | null;
  fulfilledAt: string | null;
  safeFailureCode: string | null;
  simulatedProvider: boolean;
  payment: {
    status: CheckoutWithView["paymentAttempts"][number]["status"];
    provider: CheckoutWithView["paymentAttempts"][number]["provider"];
    initialized: boolean;
  } | null;
  bookingReference: string | null;
  event: { title: string; publicSlug: string };
  session: {
    id: string;
    startAt: string;
    timeZone: string;
    venueName: string;
    spaceName: string;
    city: string;
  };
  seats: Array<{
    inventoryId: string;
    seatLabel: string;
    rowLabel: string;
    sectionName: string;
    sectionCode: string;
    tierName: string;
    tierCode: string;
    priceMinor: number;
    currency: SupportedCurrency;
  }>;
}

export function mapCheckoutToView(
  order: CheckoutWithView,
  now = new Date(),
): CustomerCheckoutView {
  const payment = order.paymentAttempts[0] ?? null;
  return {
    publicReference: order.publicReference,
    status: order.status,
    displayState: toCheckoutDisplayState({
      orderStatus: order.status,
      paymentStatus: payment?.status ?? null,
      bookingConfirmed: order.booking?.status === "CONFIRMED",
      checkoutExpiresAt: order.checkoutExpiresAt,
      now,
    }),
    currency: order.currency,
    subtotalMinor: order.subtotalMinor,
    totalMinor: order.totalMinor,
    checkoutExpiresAt: order.checkoutExpiresAt.toISOString(),
    paidAt: order.paidAt?.toISOString() ?? null,
    fulfilledAt: order.fulfilledAt?.toISOString() ?? null,
    safeFailureCode: order.safeFailureCode,
    simulatedProvider: payment?.provider === "LOCAL_SIGNED",
    payment: payment
      ? {
          status: payment.status,
          provider: payment.provider,
          initialized: payment.providerIntentId !== null,
        }
      : null,
    bookingReference: order.booking?.publicReference ?? null,
    event: order.event,
    session: {
      id: order.session.id,
      startAt: order.session.startAt.toISOString(),
      timeZone: order.session.venue.timeZone,
      venueName: order.session.venue.name,
      spaceName: order.session.space.name,
      city: order.session.venue.city,
    },
    seats: order.items.map((item) => ({
      inventoryId: item.inventoryId,
      seatLabel: item.seatLabel,
      rowLabel: item.rowLabel,
      sectionName: item.sectionName,
      sectionCode: item.sectionCode,
      tierName: item.tierName,
      tierCode: item.tierCode,
      priceMinor: item.priceMinor,
      currency: item.currency,
    })),
  };
}

export async function getCustomerCheckoutByReference(
  database: PrismaClient,
  actor: { userId: string },
  publicReference: string,
  now = new Date(),
) {
  const order = await database.checkoutOrder.findUnique({
    where: { publicReference },
    include: checkoutViewInclude,
  });
  if (!order || order.userId !== actor.userId) throw new CheckoutAuthorizationError();
  return mapCheckoutToView(order, now);
}

