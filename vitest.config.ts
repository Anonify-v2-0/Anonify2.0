import path from "node:path"

import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // The database-backed suites need a real Postgres and their own
    // configuration; see vitest.integration.config.ts and `pnpm test:db`.
    exclude: ["**/node_modules/**", "tests/integration/**"],
    globals: false,
  },
})
