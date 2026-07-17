import Link from "next/link";

import { buttonStyles } from "@/components/ui/button";
import { Container } from "@/components/ui/container";
import { ROUTES } from "@/config/site";

export default function ForbiddenPage() {
  return (
    <section className="bg-slate-50 py-20 sm:py-28">
      <Container>
        <div className="mx-auto max-w-2xl rounded-[2rem] border border-slate-200 bg-white p-8 text-center shadow-xl shadow-slate-950/5 sm:p-12">
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-orange-600">
            Access denied
          </p>
          <h1 className="mt-4 text-4xl font-black tracking-[-0.05em] text-slate-950">
            This workspace is not available to your account.
          </h1>
          <p className="mt-5 text-base leading-7 text-slate-600">
            Your session is valid, but you do not have the required platform or
            organization permission.
          </p>
          <Link
            href={ROUTES.customerDashboard}
            className={buttonStyles({ className: "mt-8", size: "lg" })}
          >
            Go to your dashboard
          </Link>
        </div>
      </Container>
    </section>
  );
}
