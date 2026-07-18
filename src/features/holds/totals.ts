import type { SupportedCurrency } from "@/config/site";

export interface PricedItem {
  priceMinor: number;
  currency: SupportedCurrency;
}

export interface HoldTotal {
  totalMinor: number;
  currency: SupportedCurrency;
  seatCount: number;
}

/**
 * Sum priced items using integer minor-unit arithmetic only. Every seat in a
 * session shares one currency (enforced in the database), but a mismatch is
 * treated as a programming error rather than silently coerced.
 */
export function calculateHoldTotal(items: PricedItem[]): HoldTotal {
  if (items.length === 0) {
    throw new Error("A hold total requires at least one seat.");
  }

  const currency = items[0]!.currency;
  let totalMinor = 0;

  for (const item of items) {
    if (item.currency !== currency) {
      throw new Error("A hold cannot mix currencies.");
    }
    if (!Number.isInteger(item.priceMinor) || item.priceMinor < 0) {
      throw new Error("Seat prices must be non-negative integer minor units.");
    }
    totalMinor += item.priceMinor;
  }

  return { totalMinor, currency, seatCount: items.length };
}
