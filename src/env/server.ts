import "server-only";

import { readApplicationEnvironment } from "@/env/schema";

let cachedEnvironment: ReturnType<typeof readApplicationEnvironment> | undefined;

export function getServerEnvironment() {
  cachedEnvironment ??= readApplicationEnvironment();
  return cachedEnvironment;
}
