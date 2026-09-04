import { randomBytes } from "node:crypto"
import { rm } from "node:fs/promises"
import path from "node:path"

import { afterAll, afterEach, describe, expect, it } from "vitest"

import { detectDriver } from "@/lib/database/prisma"
import { configuredProviderName, selectOcrProvider } from "@/lib/ocr"
import { wordsFromBlocks } from "@/lib/ocr/mistral"
import {
  driverForKey,
  localDriver,
  s3ConfigFromEnv,
  selectStorageDriver,
} from "@/lib/storage/drivers"
import { getObject, objectExists, putObject } from "@/lib/storage/blob"

const STORAGE_KEYS = [
  "STORAGE_DRIVER",
  "BLOB_READ_WRITE_TOKEN",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
]

afterEach(() => {
  for (const key of [...STORAGE_KEYS, "OCR_PROVIDER", "MISTRAL_API_KEY", "DATABASE_DRIVER"]) {
    delete process.env[key]
  }
})

afterAll(async () => {
  await rm(path.join(process.cwd(), ".anonify-storage", "test-providers"), {
    recursive: true,
    force: true,
  })
})

describe("storage driver selection", () => {
  it("falls back to the filesystem so a fresh clone works with nothing set", () => {
    expect(selectStorageDriver().name).toBe("local")
  })

  it("prefers Vercel Blob when a token is present", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test"
    expect(selectStorageDriver().name).toBe("vercel-blob")
  })

  it("uses S3 when a bucket and credentials are present", () => {
    process.env.S3_BUCKET = "anonify"
    process.env.S3_ACCESS_KEY_ID = "key"
    process.env.S3_SECRET_ACCESS_KEY = "secret"

    expect(selectStorageDriver().name).toBe("s3")
  })

  it("honours an explicit choice over what happens to be configured", () => {
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test"
    process.env.STORAGE_DRIVER = "local"

    expect(selectStorageDriver().name).toBe("local")
  })

  it("refuses a driver whose configuration is missing, rather than guessing", () => {
    process.env.STORAGE_DRIVER = "s3"
    expect(() => selectStorageDriver()).toThrow(/S3_BUCKET/)

    process.env.STORAGE_DRIVER = "vercel-blob"
    expect(() => selectStorageDriver()).toThrow(/BLOB_READ_WRITE_TOKEN/)
  })

  it("rejects an unknown driver name", () => {
    process.env.STORAGE_DRIVER = "dropbox"
    expect(() => selectStorageDriver()).toThrow(/must be one of/)
  })

  it("infers MinIO's path-style addressing from a custom endpoint", () => {
    process.env.S3_BUCKET = "anonify"
    process.env.S3_ACCESS_KEY_ID = "key"
    process.env.S3_SECRET_ACCESS_KEY = "secret"
    process.env.S3_ENDPOINT = "http://localhost:9000"

    expect(s3ConfigFromEnv()?.forcePathStyle).toBe(true)
  })
})

describe("reading back what was written", () => {
  it("picks the driver from the key, not the current configuration", () => {
    // A document stored on disk stays readable after the deployment moves to
    // Vercel Blob; otherwise a config change would orphan every document.
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_test"

    expect(driverForKey("local:documents/a/source.bin").name).toBe("local")
    expect(driverForKey("https://blob.example.com/x").name).toBe("vercel-blob")
  })

  it("says so plainly when a key needs a backend that is gone", () => {
    expect(() => driverForKey("s3:documents/a/source.bin")).toThrow(
      /no longer configured/
    )
  })
})

describe("the local driver round-trips through the public API", () => {
  it("stores and returns the same bytes", async () => {
    const key = `test-providers/${randomBytes(4).toString("hex")}.bin`
    const payload = new Uint8Array(Buffer.from("sealed document bytes"))

    const stored = await putObject(key, payload)
    expect(stored.key.startsWith("local:")).toBe(true)

    const read = await getObject(stored.key)
    expect(read.equals(Buffer.from(payload))).toBe(true)
    expect(await objectExists(stored.key)).toBe(true)
  })

  it("reports the upload mode the browser should use", () => {
    expect(localDriver.clientUpload).toBe("server-route")
  })
})

describe("database driver selection", () => {
  it("recognises a Neon connection string", () => {
    expect(
      detectDriver("postgresql://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/db")
    ).toBe("neon")
  })

  it("treats anything else as plain Postgres", () => {
    expect(detectDriver("postgresql://anonify:anonify@localhost:5432/anonify")).toBe(
      "postgres"
    )
    expect(detectDriver("postgres://user:pass@db:5432/app")).toBe("postgres")
  })

  it("lets the guess be overridden", () => {
    process.env.DATABASE_DRIVER = "neon"
    expect(detectDriver("postgresql://localhost:5432/app")).toBe("neon")
  })

  it("rejects an unknown driver", () => {
    process.env.DATABASE_DRIVER = "mysql"
    expect(() => detectDriver("postgresql://localhost/app")).toThrow(
      /must be one of/
    )
  })
})

describe("OCR provider selection", () => {
  it("defaults to Tesseract, which needs no account", () => {
    const { provider, reason } = selectOcrProvider()

    expect(provider.name).toBe("tesseract")
    expect(provider.local).toBe(true)
    expect(reason).toBe("default")
  })

  it("uses Mistral when configured with a key", () => {
    process.env.OCR_PROVIDER = "mistral"
    process.env.MISTRAL_API_KEY = "test-key"

    const { provider } = selectOcrProvider()
    expect(provider.name).toBe("mistral")
    expect(provider.granularity).toBe("block")
  })

  it("refuses rather than silently falling back to a different engine", () => {
    // Substituting Tesseract here would change both the quality and the
    // geometry of every result without saying so.
    process.env.OCR_PROVIDER = "mistral"

    expect(() => selectOcrProvider()).toThrow(/MISTRAL_API_KEY/)
  })

  it("rejects an unknown provider name", () => {
    process.env.OCR_PROVIDER = "abbyy"
    expect(() => selectOcrProvider()).toThrow(/must be one of/)
    expect(configuredProviderName()).toBeNull()
  })
})

describe("Mistral block mapping", () => {
  const block = (
    type: string,
    content: string,
    box: [number, number, number, number]
  ) => ({
    type,
    content,
    topLeftX: box[0],
    topLeftY: box[1],
    bottomRightX: box[2],
    bottomRightY: box[3],
  })

  it("converts block boxes into the word-shaped records the pipeline reads", () => {
    const words = wordsFromBlocks([
      block("text", "Patient John Smith", [40, 60, 400, 120]),
    ])

    expect(words).toHaveLength(1)
    expect(words[0].bbox).toEqual({ x0: 40, y0: 60, x1: 400, y1: 120 })
    expect(words[0].text).toBe("Patient John Smith")
  })

  it("keeps headers and footers, which carry sensitive text too", () => {
    const words = wordsFromBlocks([
      block("header", "Confidential — John Smith", [0, 0, 500, 40]),
      block("footer", "page 1", [0, 760, 500, 790]),
    ])

    expect(words).toHaveLength(2)
  })

  it("skips blocks with no readable text", () => {
    const words = wordsFromBlocks([
      block("image", "", [0, 0, 100, 100]),
      block("text", "   ", [0, 0, 100, 100]),
    ])

    expect(words).toHaveLength(0)
  })
})
