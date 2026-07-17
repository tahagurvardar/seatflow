import { Container } from "@/components/ui/container";
import { Skeleton } from "@/components/ui/skeleton";

export default function VenueOperatorLoading() {
  return (
    <section className="bg-slate-50 py-12 sm:py-16">
      <Container>
        <Skeleton className="h-4 w-44" />
        <Skeleton className="mt-6 h-12 w-full max-w-xl" />
        <Skeleton className="mt-4 h-5 w-full max-w-2xl" />
        <div className="mt-9 grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </Container>
    </section>
  );
}
