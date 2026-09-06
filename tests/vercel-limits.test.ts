import { afterEach, describe, expect, it } from "vitest"

import { fileResponse } from "@/lib/api/http"
import { selectStorageDriver } from "@/lib/storage/drivers"

/**
 * The two places where a Vercel platform limit reaches into application code.
 *
 * Both are invisible locally — the container has neither a 4.5 MB response cap
 * nor a read-only filesystem — so nothing else in this suite would notice them
 * regressing. See docs/deploy-vercel.md.
 */

const ENV_KEYS = [
  "VERCEL",
  "STORAGE_DRIVER",
  "BLOB_READ_WRITE_TOKEN",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const

const saved = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]])
) as Record<(typeof ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

/** Clears every storage variable, so a case sets only what it means to. */
function clearStorageEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key]
}

describe("fileResponse", () => {
  it("streams rather than buffering, so Vercel's 4.5 MB cap does not apply", () => {
    const response = fileResponse(new Uint8Array(16), { "content-type": "x/y" })

    expect(response.body).toBeInstanceOf(ReadableStream)
    // A content-length beside a stream is what makes an intermediary treat the
    // response as buffered again, which reinstates the limit.
    expect(response.headers.get("content-length")).toBeNull()
  })

  it("delivers the exact bytes, across a payload larger than one chunk", async () => {
    // Larger than STREAM_CHUNK_BYTES and not a multiple of it, so the final
    // partial chunk is exercised rather than assumed.
    const bytes = new Uint8Array(1024 * 1024 + 7)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251

    const response = fileResponse(bytes, { "content-type": "application/pdf" })
    const received = new Uint8Array(await response.arrayBuffer())

    expect(received.byteLength).toBe(bytes.byteLength)
    expect(Buffer.from(received).equals(Buffer.from(bytes))).toBe(true)
  })

  it("carries the headers it was given", () => {
    const response = fileResponse(new Uint8Array(1), {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="a.zip"',
      "cache-control": "no-store, private",
    })

    expect(response.headers.get("content-type")).toBe("application/zip")
    expect(response.headers.get("cache-control")).toBe("no-store, private")
  })

  it("handles an empty payload without hanging", async () => {
    const response = fileResponse(new Uint8Array(0), { "content-type": "x/y" })
    expect((await response.arrayBuffer()).byteLength).toBe(0)
  })
})

describe("storage driver selection on Vercel", () => {
  it("refuses the filesystem fallback, naming what to set", () => {
    clearStorageEnv()
    process.env.VERCEL = "1"

    // The message is the whole point: the symptom without it is a 413 on
    // upload, which points nowhere near the missing configuration.
    expect(() => selectStorageDriver()).toThrow(/BLOB_READ_WRITE_TOKEN/)
    expect(() => selectStorageDriver()).toThrow(/read-only/)
  })

  it("refuses an explicit STORAGE_DRIVER=local on Vercel too", () => {
    clearStorageEnv()
    process.env.VERCEL = "1"
    process.env.STORAGE_DRIVER = "local"

    expect(() => selectStorageDriver()).toThrow(/cannot be used on Vercel/)
  })

  it("accepts Blob on Vercel, and uploads the browser's bytes directly", () => {
    clearStorageEnv()
    process.env.VERCEL = "1"
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test"

    const driver = selectStorageDriver()
    expect(driver.name).toBe("vercel-blob")
    // Not incidental: a server-route upload on Vercel meets the 4.5 MB request
    // cap, so this is what makes a 12 MB document possible at all.
    expect(driver.clientUpload).toBe("vercel-blob")
  })

  it("accepts S3 on Vercel", () => {
    clearStorageEnv()
    process.env.VERCEL = "1"
    process.env.S3_BUCKET = "anonify"
    process.env.S3_ACCESS_KEY_ID = "key"
    process.env.S3_SECRET_ACCESS_KEY = "secret"

    expect(selectStorageDriver().name).toBe("s3")
  })

  it("still falls back to the filesystem off Vercel", () => {
    clearStorageEnv()

    expect(selectStorageDriver().name).toBe("local")
  })
})
