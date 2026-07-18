import type { SupportedCurrency } from "@/config/site";

export const CURRENCY_MINOR_UNITS: Record<SupportedCurrency, number> = {
  AZN: 2,
  EUR: 2,
  GBP: 2,
  USD: 2,
};

export function parsePriceToMinorUnits(
  value: string,
  currency: SupportedCurrency,
) {
  const normalized = value.trim();
  const digits = CURRENCY_MINOR_UNITS[currency];
  const pattern = new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`);

  if (!pattern.test(normalized)) {
    throw new Error(`Enter a non-negative ${currency} amount with up to ${digits} decimals.`);
  }

  const [whole, fraction = ""] = normalized.split(".");
  const minor = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));

  if (!Number.isSafeInteger(minor) || minor > 2_147_483_647) {
    throw new Error("The price is outside the supported range.");
  }

  return minor;
}

export function formatMinorCurrency(
  amountMinor: number,
  currency: SupportedCurrency,
  locale = "en",
) {
  const digits = CURRENCY_MINOR_UNITS[currency];
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

export function minorUnitsToInputValue(
  amountMinor: number,
  currency: SupportedCurrency,
) {
  const digits = CURRENCY_MINOR_UNITS[currency];
  return (amountMinor / 10 ** digits).toFixed(digits);
}
