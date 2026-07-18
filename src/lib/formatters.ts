import type { SupportedCurrency } from "@/config/site";

export function formatCurrency(
  amount: number,
  currency: SupportedCurrency,
): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
  }).format(amount);
}

export function formatEventDate(date: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone,
  }).format(new Date(date));
}

export function formatEventTime(date: string, timeZone = "UTC"): string {
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(date));
}

export function getDateBadge(
  date: string,
  timeZone = "UTC",
): { month: string; day: string } {
  const value = new Date(date);
  return {
    month: new Intl.DateTimeFormat("en", {
      month: "short",
      timeZone,
    })
      .format(value)
      .toUpperCase(),
    day: new Intl.DateTimeFormat("en", {
      day: "2-digit",
      timeZone,
    }).format(value),
  };
}
