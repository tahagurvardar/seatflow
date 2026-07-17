import "server-only";

import { cache } from "react";
import { headers } from "next/headers";

import { getAuth } from "@/lib/auth";

export const getCurrentSession = cache(async () => {
  const requestHeaders = await headers();

  return getAuth().api.getSession({ headers: requestHeaders });
});
