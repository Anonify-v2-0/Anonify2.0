import { PrismaNeon } from "@prisma/adapter-neon"

import { PrismaClient } from "./generated/client"

/**
 * The database client, created on first use rather than on import.
 *
 * Modules that touch the database are imported by build tooling and by unit
 * tests that never issue a query; connecting eagerly would make those fail for
 * want of a connection string they do not need.
 */

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set")
  }

  return new PrismaClient({
    adapter: new PrismaNeon({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  })
}

export function getPrisma(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient()
  }
  return globalForPrisma.prisma
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, property, receiver) {
    return Reflect.get(getPrisma(), property, receiver)
  },
})
