import type { SupportedCurrency } from "@/config/site";

export interface CheckoutPricedItem {
  priceMinor: number;
  currency: SupportedCurrency;
}

export function calculateCheckoutTotal(items: readonly CheckoutPricedItem[]) {
  if (items.length === 0) {
    throw new Error("A checkout order requires at least one seat.");
  }

  const currency = items[0]!.currency;
  let totalMinor = 0;
  for (const item of items) {
    if (item.currency !== currency) {
      throw new Error("A checkout order cannot mix currencies.");
    }
    if (!Number.isSafeInteger(item.priceMinor) || item.priceMinor < 0) {
      throw new Error("Checkout prices must be non-negative safe integer minor units.");
    }
    totalMinor += item.priceMinor;
    if (!Number.isSafeInteger(totalMinor) || totalMinor > 2_147_483_647) {
      throw new Error("Checkout total exceeds the supported amount range.");
    }
  }

  return { subtotalMinor: totalMinor, totalMinor, currency, seatCount: items.length };
}

