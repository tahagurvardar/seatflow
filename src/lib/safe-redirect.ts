export function getSafeRedirectPath(
  candidate: string | null | undefined,
  fallback: string,
) {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }

  try {
    const url = new URL(candidate, "https://seatflow.local");
    return url.origin === "https://seatflow.local"
      ? `${url.pathname}${url.search}${url.hash}`
      : fallback;
  } catch {
    return fallback;
  }
}
