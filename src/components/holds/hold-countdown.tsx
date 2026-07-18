"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { cn } from "@/lib/utils";

function secondsUntil(iso: string) {
  return Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
}

/**
 * A purely informational countdown. Server time and database state decide
 * whether a hold is still valid; when this timer reaches zero it simply asks the
 * server to re-render, which then shows the authoritative expired state.
 */
export function HoldCountdown({
  expiresAt,
  className,
}: {
  expiresAt: string;
  className?: string;
}) {
  const router = useRouter();
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));
  const refreshedRef = useRef(false);

  useEffect(() => {
    const interval = setInterval(() => {
      const next = secondsUntil(expiresAt);
      setRemaining(next);
      // When the informational timer reaches zero, ask the server to re-render
      // once so the authoritative expired state is shown.
      if (next <= 0 && !refreshedRef.current) {
        refreshedRef.current = true;
        router.refresh();
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt, router]);

  if (remaining <= 0) {
    return (
      <span role="status" className={cn("font-black text-red-700", className)}>
        Confirming with server…
      </span>
    );
  }

  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return (
    <span
      role="timer"
      aria-live="off"
      className={cn("font-mono font-black tabular-nums", className)}
    >
      {minutes}:{String(seconds).padStart(2, "0")}
    </span>
  );
}
