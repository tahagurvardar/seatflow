import { getDatabase } from "@/lib/database";
import { getCurrentSession } from "@/lib/session";
import { getPaymentOperationsHealth } from "@/server/payments/operations-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await getCurrentSession();
  if (!auth) return Response.json({ error: "Authentication is required." }, { status: 401 });
  const database = getDatabase();
  const user = await database.user.findUnique({ where: { id: auth.user.id }, select: { platformRole: true } });
  if (user?.platformRole !== "ADMIN") {
    return Response.json({ error: "Administrator access is required." }, { status: 403 });
  }
  return Response.json(await getPaymentOperationsHealth(database), {
    headers: { "Cache-Control": "private, no-store, max-age=0" },
  });
}

