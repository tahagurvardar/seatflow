"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fieldControlStyles, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { ROUTES } from "@/config/site";
import { loginSchema, registrationSchema } from "@/features/auth/schema";
import { authClient } from "@/lib/auth-client";

interface AuthFormProps {
  mode: "login" | "register";
  redirectTo: string;
}

type AuthField = "name" | "email" | "password";
type FieldErrors = Partial<Record<AuthField, string>>;

function flattenFieldErrors(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};

  for (const issue of error.issues) {
    const field = issue.path[0];

    if (
      (field === "name" || field === "email" || field === "password") &&
      !errors[field]
    ) {
      errors[field] = issue.message;
    }
  }

  return errors;
}

export function AuthForm({ mode, redirectTo }: AuthFormProps) {
  const router = useRouter();
  const isLogin = mode === "login";
  const [pending, setPending] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (pending) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const input = {
      name: formData.get("name"),
      email: formData.get("email"),
      password: formData.get("password"),
    };
    const result = isLogin
      ? ({ mode: "login", result: loginSchema.safeParse(input) } as const)
      : ({
          mode: "register",
          result: registrationSchema.safeParse(input),
        } as const);

    setFieldErrors({});
    setFormError(undefined);

    if (!result.result.success) {
      setFieldErrors(flattenFieldErrors(result.result.error));
      return;
    }

    setPending(true);

    try {
      const response = result.mode === "login"
        ? await authClient.signIn.email({
            email: result.result.data.email,
            password: result.result.data.password,
          })
        : await authClient.signUp.email({
            name: result.result.data.name,
            email: result.result.data.email,
            password: result.result.data.password,
          });

      if (response.error) {
        setFormError(
          isLogin
            ? "Unable to sign in with those credentials."
            : "Unable to create an account. Check your details and try again.",
        );
        return;
      }

      router.replace(redirectTo);
      router.refresh();
    } catch {
      setFormError("SeatFlow could not complete that request. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="grid min-h-[42rem] bg-white lg:grid-cols-[0.9fr_1.1fr]">
      <div className="flex items-center justify-center px-5 py-14 sm:px-8">
        <div className="w-full max-w-md">
          <Badge className="bg-orange-50 text-orange-700 ring-orange-600/15">
            Secure account access
          </Badge>
          <h1 className="mt-5 text-4xl font-black tracking-[-0.05em] text-slate-950">
            {isLogin ? "Welcome back." : "Create your SeatFlow account."}
          </h1>
          <p className="mt-4 text-sm leading-6 text-slate-600">
            {isLogin
              ? "Sign in to open your customer and organization workspaces."
              : "Every account starts as a customer. Organization access is added through memberships."}
          </p>

          <form className="mt-8 space-y-5" onSubmit={handleSubmit} noValidate>
            {!isLogin ? (
              <div>
                <FieldLabel htmlFor="name">Full name</FieldLabel>
                <input
                  id="name"
                  name="name"
                  className={`${fieldControlStyles} mt-2`}
                  type="text"
                  autoComplete="name"
                  placeholder="Alex Morgan"
                  disabled={pending}
                  aria-invalid={Boolean(fieldErrors.name)}
                  aria-describedby={fieldErrors.name ? "name-error" : undefined}
                />
                {fieldErrors.name ? (
                  <p id="name-error" className="mt-2 text-sm text-red-700">
                    {fieldErrors.name}
                  </p>
                ) : null}
              </div>
            ) : null}

            <div>
              <FieldLabel htmlFor="email">Email address</FieldLabel>
              <input
                id="email"
                name="email"
                className={`${fieldControlStyles} mt-2`}
                type="email"
                autoComplete="email"
                inputMode="email"
                placeholder="alex@example.com"
                disabled={pending}
                aria-invalid={Boolean(fieldErrors.email)}
                aria-describedby={fieldErrors.email ? "email-error" : undefined}
              />
              {fieldErrors.email ? (
                <p id="email-error" className="mt-2 text-sm text-red-700">
                  {fieldErrors.email}
                </p>
              ) : null}
            </div>

            <div>
              <FieldLabel htmlFor="password">Password</FieldLabel>
              <input
                id="password"
                name="password"
                className={`${fieldControlStyles} mt-2`}
                type="password"
                autoComplete={isLogin ? "current-password" : "new-password"}
                disabled={pending}
                aria-invalid={Boolean(fieldErrors.password)}
                aria-describedby={
                  fieldErrors.password ? "password-error" : "password-hint"
                }
              />
              {!isLogin ? (
                <p id="password-hint" className="mt-2 text-xs text-slate-500">
                  Use 8 to 128 characters.
                </p>
              ) : null}
              {fieldErrors.password ? (
                <p id="password-error" className="mt-2 text-sm text-red-700">
                  {fieldErrors.password}
                </p>
              ) : null}
            </div>

            <div aria-live="polite" aria-atomic="true">
              {formError ? (
                <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800">
                  {formError}
                </p>
              ) : null}
            </div>

            <Button size="lg" className="w-full" type="submit" disabled={pending}>
              {pending
                ? isLogin
                  ? "Signing in…"
                  : "Creating account…"
                : isLogin
                  ? "Sign in"
                  : "Create account"}
            </Button>
          </form>

          <div className="mt-5 flex gap-3 rounded-2xl bg-emerald-50 p-4 text-xs leading-5 text-emerald-900">
            <Icon name="shield" className="mt-0.5 size-4 shrink-0" />
            Passwords are handled by Better Auth and sessions are stored
            server-side in PostgreSQL.
          </div>
          <p className="mt-7 text-center text-sm text-slate-600">
            {isLogin ? "New to SeatFlow?" : "Already have an account?"}{" "}
            <Link
              href={isLogin ? ROUTES.register : ROUTES.login}
              className="rounded font-bold text-orange-600 hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
            >
              {isLogin ? "Create an account" : "Sign in"}
            </Link>
          </p>
        </div>
      </div>

      <div className="relative hidden overflow-hidden bg-slate-950 p-12 text-white lg:flex lg:items-end">
        <div
          aria-hidden="true"
          className="absolute -right-20 -top-20 size-[30rem] rounded-full bg-orange-500/25 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="absolute bottom-20 left-12 h-72 w-52 rotate-12 rounded-full border-[48px] border-violet-500/20"
        />
        <div className="relative max-w-lg">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-orange-500">
            <Icon name="ticket" className="size-6" />
          </span>
          <blockquote className="mt-7 text-3xl font-black leading-tight tracking-[-0.04em]">
            “The best part should be choosing the night—not fighting the
            platform.”
          </blockquote>
          <p className="mt-5 text-sm text-slate-400">
            The product principle behind SeatFlow
          </p>
        </div>
      </div>
    </div>
  );
}
