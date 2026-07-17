import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AuthForm } from "@/components/auth/auth-form";
import { ROUTES } from "@/config/site";
import { getSafeRedirectPath } from "@/lib/safe-redirect";
import { getCurrentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in securely to your SeatFlow account.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ redirectTo?: string | string[] }>;
}) {
  const [session, parameters] = await Promise.all([
    getCurrentSession(),
    searchParams,
  ]);
  const requestedPath = Array.isArray(parameters.redirectTo)
    ? parameters.redirectTo[0]
    : parameters.redirectTo;
  const redirectTo = getSafeRedirectPath(
    requestedPath,
    ROUTES.customerDashboard,
  );

  if (session) {
    redirect(redirectTo);
  }

  return <AuthForm mode="login" redirectTo={redirectTo} />;
}
