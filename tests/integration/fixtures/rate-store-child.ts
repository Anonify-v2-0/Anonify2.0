/**
 * One "replica" for the cross-process tests in rate-store.integration.test.ts
 * (#184). Run with tsx; prints one line of JSON and exits.
 *
 *   STORE   postgres | redis
 *   MODE    lease: take leases under LIMIT, hold each HOLD_MS, ROUNDS times,
 *                  telling COUNTER_URL when each is held
 *           rate:  take tokens at RPM from START until UNTIL (epoch ms), and
 *                  report how many were allowed
 *   KEY     the key every child shares
 */
import { postgresRateStore } from "@/lib/services/rate-store-postgres"
import { closeRedis, redisRateStore } from "@/lib/services/rate-store-redis"

const env = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  const store =
    env("STORE") === "redis" ? redisRateStore() : postgresRateStore()
  const key = env("KEY")

  if (env("MODE") === "lease") {
    // In flight is counted by the parent, told after a lease is acquired and
    // before it is released, so its count is never above what is held. Not
    // timestamps compared afterwards: on Windows each process's Date.now() is
    // its own calibration of the system clock, a few milliseconds apart.
    const counter = env("COUNTER_URL")
    const limit = Number(env("LIMIT"))
    const holdMs = Number(env("HOLD_MS"))
    let rounds = 0
    for (; rounds < Number(env("ROUNDS")); rounds++) {
      let lease: { id: string } | null = null
      while (!(lease = await store.acquireLease(key, limit, 30_000)))
        await sleep(5)
      await fetch(`${counter}/in`, { method: "POST" })
      await sleep(holdMs)
      await fetch(`${counter}/out`, { method: "POST" })
      await store.releaseLease(key, lease.id)
    }
    return { rounds }
  }

  const perMinute = Number(env("RPM"))
  const config = {
    burst: Math.max(1, Math.ceil(perMinute / 60)),
    refillPerSecond: perMinute / 60,
  }
  const until = Number(env("UNTIL"))
  await sleep(Math.max(0, Number(env("START")) - Date.now()))
  let allowed = 0
  while (Date.now() < until) {
    const decision = await store.take(key, config, new Date())
    if (decision.allowed) allowed++
    else await sleep(Math.min(decision.waitMs, until - Date.now()))
  }
  return { allowed }
}

main()
  .then(async (result) => {
    console.log(JSON.stringify(result))
    await closeRedis()
    process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
