/**
 * Compare two seat selections for idempotency. Order does not matter, but the
 * exact set must match: replaying an idempotent request with the same seats is a
 * safe no-op, while the same key with a different set is a conflict.
 */
export function seatSelectionsMatch(first: string[], second: string[]): boolean {
  if (first.length !== second.length) return false;
  const seen = new Set(first);
  return second.every((value) => seen.has(value));
}
