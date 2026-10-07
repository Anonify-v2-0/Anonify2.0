import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The storage calls #167 and #170 added: a probe for readiness, and deleting
 * many objects in as few requests as the backend allows.
 */

const sent = vi.hoisted(() => ({
  commands: [] as Array<{ name: string; input: Record<string, unknown> }>,
  reply: (() => ({})) as (
    name: string,
    input: Record<string, unknown>
  ) => unknown,
}))

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  const named = (name: string) =>
    class extends Command {
      static commandName = name
      commandName = name
    }
  return {
    S3Client: class {
      async send(command: {
        commandName: string
        input: Record<string, unknown>
      }) {
        sent.commands.push({ name: command.commandName, input: command.input })
        return sent.reply(command.commandName, command.input)
      }
    },
    DeleteObjectsCommand: named("DeleteObjects"),
    DeleteObjectCommand: named("DeleteObject"),
    HeadBucketCommand: named("HeadBucket"),
    HeadObjectCommand: named("HeadObject"),
  }
})

const { createS3Driver, localDriver } = await import("@/lib/storage/drivers")
const { deleteObjects } = await import("@/lib/storage/blob")
const { cleanupSettings } = await import("@/lib/workflows/cleanup")

const s3 = createS3Driver({
  bucket: "anonify",
  region: "us-east-1",
  accessKeyId: "a",
  secretAccessKey: "b",
  forcePathStyle: true,
})

afterEach(() => {
  sent.commands.length = 0
  sent.reply = () => ({})
  vi.unstubAllEnvs()
})

describe("deleting many objects on S3 (#170)", () => {
  it("sends a thousand keys a request, and reports the ones that failed", async () => {
    const keys = Array.from({ length: 2500 }, (_, i) => `s3:documents/${i}`)
    sent.reply = (_name, input) => {
      const objects = (input.Delete as { Objects: { Key: string }[] }).Objects
      return {
        Errors: objects
          .filter((o) => o.Key === "documents/7" || o.Key === "documents/8")
          .map((o) => ({
            Key: o.Key,
            // Already gone is a delete that succeeded.
            Code: o.Key === "documents/7" ? "AccessDenied" : "NoSuchKey",
          })),
      }
    }

    const { failed } = await s3.deleteMany(keys)

    expect(sent.commands.map((c) => c.name)).toEqual([
      "DeleteObjects",
      "DeleteObjects",
      "DeleteObjects",
    ])
    expect(
      sent.commands.map(
        (c) => (c.input.Delete as { Objects: unknown[] }).Objects.length
      )
    ).toEqual([1000, 1000, 500])
    expect(sent.commands[0].input).toMatchObject({ Bucket: "anonify" })
    // The stored handle, not the bucket path.
    expect(failed).toEqual(["s3:documents/7"])
  })

  it("counts every key of a request that failed outright as not deleted", async () => {
    sent.reply = () => {
      throw new Error("connection reset")
    }
    expect((await s3.deleteMany(["s3:a", "s3:b"])).failed).toEqual([
      "s3:a",
      "s3:b",
    ])
  })

  it("probes the bucket with HeadBucket for readiness (#167)", async () => {
    await s3.probe()
    expect(sent.commands).toEqual([
      { name: "HeadBucket", input: { Bucket: "anonify" } },
    ])
  })
})

describe("deleting many objects on the local filesystem", () => {
  it("deletes what is there and counts what is already gone as deleted", async () => {
    const one = await localDriver.put(
      `test/bulk/${Date.now()}-1`,
      new Uint8Array([1])
    )
    const two = await localDriver.put(
      `test/bulk/${Date.now()}-2`,
      new Uint8Array([2])
    )
    const { failed } = await localDriver.deleteMany([
      one.key,
      two.key,
      "local:test/bulk/never-written",
    ])
    expect(failed).toEqual([])
    expect(await localDriver.exists(one.key)).toBe(false)
    expect(await localDriver.exists(two.key)).toBe(false)
    await expect(localDriver.probe()).resolves.toBeUndefined()
  })

  it("sends each key to the backend its handle names", async () => {
    vi.stubEnv("S3_BUCKET", "anonify")
    vi.stubEnv("S3_ACCESS_KEY_ID", "a")
    vi.stubEnv("S3_SECRET_ACCESS_KEY", "b")
    const local = await localDriver.put(
      `test/bulk/${Date.now()}-3`,
      new Uint8Array([3])
    )

    const { failed } = await deleteObjects([local.key, "s3:documents/1"])

    expect(failed).toEqual([])
    expect(await localDriver.exists(local.key)).toBe(false)
    // One bulk request, for the S3 key alone; the local key never reached it.
    expect(sent.commands.map((c) => c.input)).toEqual([
      {
        Bucket: "anonify",
        Delete: { Objects: [{ Key: "documents/1" }], Quiet: true },
      },
    ])
  })
})

describe("the sweep's settings (#170)", () => {
  it("defaults to a 240-second budget and eight at once, and refuses nonsense", () => {
    expect(cleanupSettings({})).toEqual({ budgetMs: 240_000, concurrency: 8 })
    expect(
      cleanupSettings({
        ANONIFY_CLEANUP_BUDGET_MS: "60000",
        ANONIFY_CLEANUP_CONCURRENCY: "16",
      })
    ).toEqual({ budgetMs: 60_000, concurrency: 16 })
    expect(() =>
      cleanupSettings({ ANONIFY_CLEANUP_BUDGET_MS: "soon" })
    ).toThrow(/ANONIFY_CLEANUP_BUDGET_MS/)
    expect(() => cleanupSettings({ ANONIFY_CLEANUP_CONCURRENCY: "0" })).toThrow(
      /ANONIFY_CLEANUP_CONCURRENCY/
    )
  })
})
