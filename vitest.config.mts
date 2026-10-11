import { defineConfig } from "vitest/config";

// Tests run against a real PostgreSQL database (trendz_test) and Redis DB 1.
// They run in a single fork because they share that database.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    globalSetup: ["tests/global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
