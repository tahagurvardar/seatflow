import type { Metadata } from "next";
import Link from "next/link";

import { ScannerPanel } from "@/components/tickets/scanner-panel";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";
import { requireEventSessionAccess } from "@/lib/event-authorization";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ticket scanner" };

export default async function TicketScannerPage({
  params,
}: {
  params: Promise<{ organizationSlug: string; eventSlug: string; sessionId: string }>;
}) {
  const scope = await params;
  const path = ROUTES.organizerScanner(scope.organizationSlug, scope.eventSlug, scope.sessionId);
  await requireEventSessionAccess(scope, path, "ADMIN");
  return (
    <section className="min-h-[calc(100svh-4.5rem)] bg-slate-900 py-5 sm:py-10">
      <Container className="px-3 sm:px-6">
        <nav className="mx-auto mb-4 max-w-md text-sm text-slate-400"><Link href={ROUTES.organizerSession(scope.organizationSlug, scope.eventSlug, scope.sessionId)} className="hover:text-white">Session operations</Link> / Scanner</nav>
        <ScannerPanel sessionId={scope.sessionId} />
      </Container>
    </section>
  );
}
