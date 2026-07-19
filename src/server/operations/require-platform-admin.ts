import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";

/**
 * Least-privilege guard for operational endpoints.
 *
 * Platform role is always re-read from PostgreSQL rather than trusted from the
 * session payload, so a stale or tampered session cannot grant operator access.
 * Both failure responses are bounded and disclose nothing about what the
 * endpoint would have returned.
 */
export async function requirePlatformAdmin(): Promise<
  { ok: true; userId: string } | { ok: false; response: Response }
> {
  const auth = await getCurrentSession();
  if (!auth) {
    return {
      ok: false,
      response: Response.json(
        { error: "Authentication is required." },
        { status: 401, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      ),
    };
  }

  const user = await getDatabase().user.findUnique({
    where: { id: auth.user.id },
    select: { platformRole: true },
  });

  if (user?.platformRole !== "ADMIN") {
    return {
      ok: false,
      response: Response.json(
        { error: "Administrator access is required." },
        { status: 403, headers: { "Cache-Control": "private, no-store, max-age=0" } },
      ),
    };
  }

  return { ok: true, userId: auth.user.id };
}
