import path from "node:path"

import { defineConfig } from "vitest/config"

/**
 * The database-backed suites.
 *
 * Kept out of `pnpm test` deliberately. They need a real Postgres named by
 * `TEST_DATABASE_URL`, they are slower than everything else, and they mutate
 * process-wide configuration (the connection string, the storage driver) that
 * the unit suites assert on. Run them with `pnpm test:db`; CI runs both.
 *
 * `fileParallelism` is off because these share one database: two files
 * sweeping expired documents at the same time would each see the other's rows.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/integration/**/*.integration.test.ts"],
    globals: false,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
