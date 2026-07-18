"use client";

import { useFormStatus } from "react-dom";

import { buttonStyles } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PendingSubmitButton({
  children,
  pendingLabel,
  className,
  variant = "primary",
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  variant?: "primary" | "outline" | "secondary" | "ghost";
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={cn(buttonStyles({ size: "lg", variant }), className)}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
