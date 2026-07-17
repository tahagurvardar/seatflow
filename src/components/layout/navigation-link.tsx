"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

interface NavigationLinkProps {
  href: string;
  label: string;
  mobile?: boolean;
}

export function NavigationLink({
  href,
  label,
  mobile = false,
}: NavigationLinkProps) {
  const pathname = usePathname();
  const pathnameOnly = href.split("#")[0] || "/";
  const isActive =
    pathnameOnly !== "/" &&
    (pathname === pathnameOnly || pathname.startsWith(`${pathnameOnly}/`));

  return (
    <Link
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "rounded-lg font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2",
        mobile
          ? "flex items-center justify-between px-3 py-3 text-base"
          : "px-2 py-1.5 text-sm",
        isActive
          ? "text-orange-600"
          : "text-slate-600 hover:text-slate-950",
      )}
    >
      {label}
      {mobile && isActive ? (
        <span className="size-1.5 rounded-full bg-orange-500" />
      ) : null}
    </Link>
  );
}
