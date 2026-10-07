import { createHash, randomUUID } from "node:crypto"

import type { Cluster, Redis } from "ioredis"

import type { BucketConfig } from "@/lib/security/token-bucket"
import type { RateStore, TakeResult } from "@/lib/services/rate-store"

/**
 * The cluster budget in Redis or Valkey (#184), for request rates that would
 * make the Postgres statements a hot spot, or a deployment that already runs
 * one: Redis 6 or later, Valkey, ElastiCache and MemoryDB, Memorystore, Azure
 * Cache for Redis, Upstash.
 *
 * Every operation is one Lua script on one key, so it is atomic on the server
 * and needs nothing from cluster mode: whatever slot a key hashes to, its
 * script runs there.
 *
 *   bucket   a hash of `tokens` and `updatedAt`, with token-bucket.ts's maths
 *            in Lua, on this process's clock like the Postgres statement, and
 *            expiring once it would have refilled anyway.
 *   lease    a sorted set per service: member the lease id, score its expiry
 *            on the server's clock, so replicas whose clocks disagree still
 *            agree on which leases are live.
 *
 * The client is ioredis, imported on first use like the storage SDKs, so a
 * deployment that never sets REDIS_URL never loads it. It fails fast rather
 * than queueing: a command issued while the connection is down is refused at
 * once, and the caller falls back (see lib/services/throttle.ts and
 * lib/security/rate-limit.ts) instead of a document waiting on a cache.
 */

const COMMAND_TIMEOUT_MS = 2_000

// The bucket. ARGV: burst, refill per second, now (epoch ms), 1 to spend or 0
// to only look. It does what consume() does, refusals included: they are
// written too, so the balance is refilled in the same steps and comes out the
// same to the last bit. Floats are stored with 17 significant digits so they
// read back exactly as written.
//
// `updatedAt` never moves backwards: replicas a few milliseconds apart, or
// requests that land out of order, would otherwise be refilled twice for the
// same stretch of time.
const TAKE = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = burst
  updated = now
end
local available = math.min(burst, tokens + math.max(0, now - updated) / 1000 * rate)
local allowed = available >= 1
if ARGV[4] ~= '1' then
  if allowed then return {1, math.floor(available), 0} end
  return {0, 0, math.ceil((1 - available) / rate * 1000)}
end
if allowed then available = available - 1 end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', available), 'updatedAt', string.format('%.17g', math.max(updated, now)))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst - available) / rate * 1000) + 1000)
if allowed then return {1, math.floor(available), 0} end
return {0, 0, math.ceil((1 - available) / rate * 1000)}
`

// deferBucket. ARGV: burst, refill per second, now, wait (ms).
const DEFER = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updatedAt')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = burst
  updated = now
end
local available = math.min(burst, tokens + math.max(0, now - updated) / 1000 * rate)
local deferred = 1 - math.max(0, tonumber(ARGV[4])) / 1000 * rate
if deferred < available then available = deferred end
redis.call('HSET', KEYS[1], 'tokens', string.format('%.17g', available), 'updatedAt', string.format('%.17g', math.max(updated, now)))
redis.call('PEXPIRE', KEYS[1], math.ceil((burst - available) / rate * 1000) + 1000)
return 1
`

// A lease. ARGV: limit, ttl (ms), id. Drops the expired ones, then takes a
// place if there is one. The set itself expires a TTL after its last write,
// so a service nobody calls leaves nothing behind.
const ACQUIRE = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[1]) then
  return 0
end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl)
return 1
`

// ARGV: ttl (ms), id. Only a lease that is still live is renewed: one that
// expired may already have been counted as free by another replica.
const RENEW = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
local ttl = tonumber(ARGV[1])
local expires = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[2]))
if expires == nil or expires <= now then
  return 0
end
redis.call('ZADD', KEYS[1], 'XX', now + ttl, ARGV[2])
if redis.call('PTTL', KEYS[1]) < ttl then
  redis.call('PEXPIRE', KEYS[1], ttl)
end
return 1
`

type Script = { source: string; sha: string }

function script(source: string): Script {
  return { source, sha: createHash("sha1").update(source).digest("hex") }
}

const SCRIPTS = {
  take: script(TAKE),
  defer: script(DEFER),
  acquire: script(ACQUIRE),
  renew: script(RENEW),
}

// --- configuration ----------------------------------------------------------

export type RedisConfig = {
  url: string
  /** `REDIS_KEY_PREFIX`, `anonify:` by default. */
  prefix: string
  /** `REDIS_CLUSTER=true`: connect with the cluster client. */
  cluster: boolean
}

/** REDIS_URL and its companions. A malformed value throws, naming it. */
export function redisConfigFromEnv(
  env: Record<string, string | undefined> = process.env
): RedisConfig {
  const url = env.REDIS_URL?.trim()
  if (!url) throw new Error("REDIS_URL is not set")

  let protocol: string
  try {
    protocol = new URL(url).protocol
  } catch {
    throw new Error("REDIS_URL is not a URL")
  }
  if (protocol !== "redis:" && protocol !== "rediss:")
    throw new Error("REDIS_URL must start with redis:// or rediss://")

  const cluster = env.REDIS_CLUSTER?.trim().toLowerCase()
  if (cluster && !["true", "false", "1", "0"].includes(cluster))
    throw new Error("REDIS_CLUSTER must be true or false")

  return {
    url,
    prefix: env.REDIS_KEY_PREFIX ?? "anonify:",
    cluster: cluster === "true" || cluster === "1",
  }
}

// --- the client -------------------------------------------------------------

type Client = Redis | Cluster

const shared = globalThis as unknown as {
  anonifyRedis?: { url: string; client: Promise<Client> }
}

async function createClient(config: RedisConfig): Promise<Client> {
  const { Redis, Cluster } = await import("ioredis")
  const options = {
    connectTimeout: COMMAND_TIMEOUT_MS,
    commandTimeout: COMMAND_TIMEOUT_MS,
    maxRetriesPerRequest: 1,
  }

  let client: Client
  if (config.cluster) {
    const url = new URL(config.url)
    client = new Cluster(
      [{ host: url.hostname, port: Number(url.port || 6379) }],
      {
        redisOptions: {
          ...options,
          username: decodeURIComponent(url.username) || undefined,
          password: decodeURIComponent(url.password) || undefined,
          tls: url.protocol === "rediss:" ? {} : undefined,
        },
        // A managed cluster's TLS certificate names its configuration
        // endpoint, not the addresses the nodes announce: connecting to those
        // by IP fails verification (ElastiCache documents this).
        dnsLookup: (address, callback) => callback(null, address),
        maxRedirections: 4,
      }
    )
  } else {
    client = new Redis(config.url, options)
  }

  // Without a listener an unreachable server is an unhandled 'error' event,
  // which ends the process. The failure is logged where it is noticed, by
  // the caller that falls back.
  client.on("error", () => {})
  return client
}

function clientFor(config: RedisConfig): Promise<Client> {
  if (shared.anonifyRedis?.url !== config.url) {
    shared.anonifyRedis = { url: config.url, client: createClient(config) }
  }
  return shared.anonifyRedis.client
}

/**
 * The client, if it can take a command now. While ioredis reconnects it
 * would hold a command for up to the timeout; refusing straight away is what
 * lets every caller fall back at once instead of two seconds later.
 */
async function ready(config: RedisConfig): Promise<Client> {
  const client = await clientFor(config)
  if (client.status === "reconnecting" || client.status === "end")
    throw new Error(`Redis is unreachable (${client.status})`)
  return client
}

async function run(
  client: Client,
  { source, sha }: Script,
  key: string,
  args: (string | number)[]
): Promise<unknown> {
  try {
    return await client.evalsha(sha, 1, key, ...args)
  } catch (error) {
    // First use on this server, or after a restart or SCRIPT FLUSH: send the
    // script itself, which also loads it for next time.
    if (error instanceof Error && error.message.startsWith("NOSCRIPT"))
      return client.eval(source, 1, key, ...args)
    throw error
  }
}

function bucketArgs(config: BucketConfig, now: Date): string[] {
  return [
    String(config.burst),
    String(config.refillPerSecond),
    String(now.getTime()),
  ]
}

function takeResult(reply: unknown): TakeResult {
  const [allowed, remaining, waitMs] = reply as [number, number, number]
  return { allowed: allowed === 1, remaining, waitMs }
}

export function redisRateStore(
  config: RedisConfig = redisConfigFromEnv()
): RateStore {
  const keyOf = (key: string) => `${config.prefix}${key}`

  return {
    kind: "redis",

    async take(key, bucket, now) {
      const client = await ready(config)
      return takeResult(
        await run(client, SCRIPTS.take, keyOf(key), [
          ...bucketArgs(bucket, now),
          "1",
        ])
      )
    },

    async peek(key, bucket, now) {
      const client = await ready(config)
      return takeResult(
        await run(client, SCRIPTS.take, keyOf(key), [
          ...bucketArgs(bucket, now),
          "0",
        ])
      )
    },

    async defer(key, bucket, now, waitMs) {
      const client = await ready(config)
      await run(client, SCRIPTS.defer, keyOf(key), [
        ...bucketArgs(bucket, now),
        String(Math.round(waitMs)),
      ])
    },

    async acquireLease(key, limit, ttlMs) {
      const client = await ready(config)
      const id = randomUUID()
      const reply = await run(client, SCRIPTS.acquire, keyOf(key), [
        String(limit),
        String(Math.round(ttlMs)),
        id,
      ])
      return reply === 1 ? { id } : null
    },

    async renewLease(key, id, ttlMs) {
      const client = await ready(config)
      const reply = await run(client, SCRIPTS.renew, keyOf(key), [
        String(Math.round(ttlMs)),
        id,
      ])
      return reply === 1
    },

    async releaseLease(key, id) {
      const client = await ready(config)
      await client.zrem(keyOf(key), id)
    },

    async probe() {
      const client = await ready(config)
      await client.ping()
    },
  }
}

/** For tests: drops the shared client, closing its connection. */
export async function closeRedis(): Promise<void> {
  const current = shared.anonifyRedis
  shared.anonifyRedis = undefined
  if (current) (await current.client).disconnect()
}
