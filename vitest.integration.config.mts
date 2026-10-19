import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: { "server-only": fileURLToPath(new URL("./tests/server-only.ts", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    setupFiles: ["./tests/integration/setup.ts"],
    fileParallelism: false,
    // These tests drive real PostgreSQL transactions whose own bounds are 15–30s
    // (see runInTransaction callers). Typical cases take 1–3s, which leaves the
    // 5s unit-test default less than a 2x margin; on a loaded laptop that margin
    // was exceeded with no assertion failing. A timeout is a hang detector here,
    // not a performance budget, so it sits above the default 15s transaction bound.
    testTimeout: 20_000,
    sequence: {
      concurrent: false,
    },
  },
});
