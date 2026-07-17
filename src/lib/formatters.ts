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

export function formatEventDate(date: string): string {
  const calendarDate = `${date.slice(0, 10)}T00:00:00Z`;
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(calendarDate));
}

export function formatEventTime(date: string): string {
  const match = date.match(/T(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : "Time TBC";
}

export function getDateBadge(date: string): { month: string; day: string } {
  const value = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return {
    month: new Intl.DateTimeFormat("en", {
      month: "short",
      timeZone: "UTC",
    })
      .format(value)
      .toUpperCase(),
    day: new Intl.DateTimeFormat("en", {
      day: "2-digit",
      timeZone: "UTC",
    }).format(value),
  };
}
