import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Server-module suite.
 *
 * Modules under `src/server/**` import `server-only`, which throws when
 * resolved outside a server environment. That guard is worth keeping in the
 * application — it catches an accidental client import of a module holding
 * secrets — so the tests neutralize it the same way the notification and Redis
 * suites already do, rather than the source being changed to accommodate them.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/server/**/*.test.ts"],
  },
});
