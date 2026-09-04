import "dotenv/config";
import { defineConfig, env } from "prisma/config"

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Only used by migrate/introspect. The app connects through the Neon driver
    // adapter in lib/database/prisma.ts, so `prisma generate` must keep working
    // (in CI, for example) without a database URL present.
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
  },
})
