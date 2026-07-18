import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: [
      "tests/integration/**",
      "tests/notification/**",
      "tests/pdf/**",
      "tests/redis/**",
      "node_modules/**",
    ],
    coverage: {
      reporter: ["text", "html"],
    },
  },
});
