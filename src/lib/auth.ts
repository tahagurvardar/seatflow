import "server-only";

import { getServerEnvironment } from "@/env/server";
import { getDatabase } from "@/lib/database";
import { createSeatFlowAuth } from "@/server/auth/create-seatflow-auth";

export type SeatFlowAuth = ReturnType<typeof createSeatFlowAuth>;

let authInstance: SeatFlowAuth | undefined;

export function getAuth() {
  authInstance ??= createSeatFlowAuth(
    getServerEnvironment(),
    getDatabase(),
  );
  return authInstance;
}
