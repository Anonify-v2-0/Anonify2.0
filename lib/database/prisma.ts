import { PrismaNeon } from "@prisma/adapter-neon"
import { PrismaPg } from "@prisma/adapter-pg"
import { Pool } from "pg"

import type { PrismaClient as PrismaClientType } from "./generated/client"
import { PrismaClient } from "./generated/client"
import { databasePoolConfig } from "./pool-config"

/**
 * The database client, created on first use rather than on import.
 *
 * Modules that touch the database are imported by build tooling and by unit
 * tests that never issue a query; connecting eagerly would make those fail for
 * want of a connection string they do not need.
 *
 * The driver is configuration. Neon's serverless adapter speaks HTTP/WebSocket
 * and is what the deployed demo uses; a local or self-hosted Postgres speaks
 * the wire protocol and needs the node-postgres adapter instead. Assuming Neon
 * everywhere is what made a local database impossible.
 */

export const DATABASE_DRIVERS = ["neon", "postgres"] as const

export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number]

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientType | undefined
  /** The node-postgres pool behind it, kept for its counters (#188). */
  prismaPool?: Pool
}

/**
 * Neon's hostnames are recognisable, which means the common cases need no
 * configuration at all: a Neon URL gets the Neon driver, anything else gets
 * plain Postgres. `DATABASE_DRIVER` overrides when the guess is wrong — a
 * proxy in front of Neon, say.
 */
export function detectDriver(connectionString: string): DatabaseDriver {
  const configured = process.env.DATABASE_DRIVER?.trim().toLowerCase()

  if (configured) {
    if (!(DATABASE_DRIVERS as readonly string[]).includes(configured)) {
      throw new Error(
        `DATABASE_DRIVER must be one of: ${DATABASE_DRIVERS.join(", ")}`
      )
    }
    return configured as DatabaseDriver
  }

  return /\.neon\.tech|neon\.build|\.aws\.neon\./i.test(connectionString)
    ? "neon"
    : "postgres"
}

function createClient(): PrismaClientType {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set")
  }

  const driver = detectDriver(connectionString)
  const log: ("warn" | "error")[] =
    process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]

  // Both adapters are thin wrappers, so both are imported and one is chosen.
  // The alternative — a dynamic import — would make client creation async, and
  // every call site synchronous today would have to change for no real gain.
  //
  // The pool is sized by DATABASE_POOL_MAX, so the connection budget across
  // replicas is something an operator can set (#169).
  const pool = databasePoolConfig()
  let adapter: PrismaNeon | PrismaPg
  if (driver === "neon") {
    adapter = new PrismaNeon({ connectionString, ...pool })
  } else {
    // Created here rather than by the adapter, so the metrics can read how
    // full it is (#188). The same settings the adapter would have used.
    const pg = new Pool({ connectionString, ...pool })
    globalForPrisma.prismaPool = pg
    adapter = new PrismaPg(pg)
  }

  return new PrismaClient({ adapter, log })
}

export function getPrisma(): PrismaClientType {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma = createClient()
  }
  return globalForPrisma.prisma
}

/**
 * The app pool's connections: open, idle, and callers waiting for one.
 * Undefined before the first query, and with the Neon driver, which pools
 * over HTTP.
 */
export function appPoolStats():
  | { total: number; idle: number; waiting: number }
  | undefined {
  const pool = globalForPrisma.prismaPool
  if (!pool) return undefined
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  }
}

export const prisma = new Proxy({} as PrismaClientType, {
  get(_target, property, receiver) {
    return Reflect.get(getPrisma(), property, receiver)
  },
})
