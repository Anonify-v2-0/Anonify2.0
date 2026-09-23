import { randomBytes } from "node:crypto"
import { readdir, readFile, rm } from "node:fs/promises"
import path from "node:path"

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { getObject, putObject } from "@/lib/storage/blob"
import { CHUNKED_MAGIC } from "@/lib/storage/chunked"
import { localDriver, vercelBlobDriver } from "@/lib/storage/drivers"
import { encryptWithDocumentKey } from "@/lib/storage/encryption"
import {
  documentSeal,
  encryptionFormatOf,
  getSealed,
  getSealedStream,
  newDocumentSeal,
  openSealedObject,
  putSealed,
  putSealedStream,
  type DocumentSeal,
} from "@/lib/storage/sealed"
import { collect } from "@/lib/storage/streams"
import {
  CHUNK_SIZE_ENV,
  maxInFlightChunks,
  MEMORY_BUDGET_ENV,
  streamingLimits,
} from "@/lib/storage/streaming"

/**
 * Sealed objects through the storage layer, on the filesystem driver.
 *
 * What the chunked envelope's own suite cannot show: that a document's
 * recorded format decides how its objects are read, that an object written
 * before the chunked format existed still opens, that ranges and streams come
 * back through a real driver, and that a stream which fails halfway leaves
 * nothing behind under the name it was being written to.
 */

const ROOT = "test-sealed"
const STORE = path.join(process.cwd(), ".anonify-storage", ROOT)

function key(name: string): string {
  return `${ROOT}/${randomBytes(4).toString("hex")}/${name}`
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
  // The smallest chunk configuration allows, so a few hundred kilobytes
  // crosses several chunk boundaries.
  process.env[CHUNK_SIZE_ENV] = "64KB"
})

afterEach(() => {
  delete process.env[MEMORY_BUDGET_ENV]
  vi.unstubAllGlobals()
})

afterAll(async () => {
  delete process.env[CHUNK_SIZE_ENV]
  await rm(STORE, { recursive: true, force: true })
})

async function* pieces(bytes: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.byteLength; at += size) {
    yield bytes.subarray(at, at + size)
  }
}

describe("the recorded encryption format", () => {
  it("reads a missing record as the original envelope", () => {
    expect(encryptionFormatOf(null)).toBe("v0")
    expect(encryptionFormatOf(undefined)).toBe("v0")
    expect(encryptionFormatOf("v0")).toBe("v0")
    expect(encryptionFormatOf("v1")).toBe("v1")
  })

  it("refuses a format it does not know rather than guessing", () => {
    expect(() => encryptionFormatOf("v9")).toThrow(/Unknown encryption format/)
  })

  it("seals new documents in the chunked format", () => {
    expect(newDocumentSeal().format).toBe("v1")
  })

  it("needs a key", () => {
    expect(() =>
      documentSeal({ encryptionKey: null, encryptionFormat: "v1" })
    ).toThrow()
  })
})

describe("chunked objects in storage", () => {
  const plaintext = randomBytes(300 * 1024 + 17)

  it("writes the chunked format and reads it back", async () => {
    const seal = newDocumentSeal()
    const name = key("source.bin")
    const stored = await putSealed(name, plaintext, seal)

    const raw = await getObject(stored.key)
    expect(raw.subarray(0, 4).equals(CHUNKED_MAGIC)).toBe(true)
    expect((await getSealed(stored.key, name, seal)).equals(plaintext)).toBe(
      true
    )
  })

  it("streams in and streams out without changing a byte", async () => {
    const seal = newDocumentSeal()
    const name = key("source.bin")
    const stored = await putSealedStream(name, pieces(plaintext, 999), seal)

    const out = await collect(await getSealedStream(stored.key, name, seal))
    expect(out.equals(plaintext)).toBe(true)
    expect((await getSealed(stored.key, name, seal)).equals(plaintext)).toBe(
      true
    )
  })

  it("serves any range through ranged reads", async () => {
    const seal = newDocumentSeal()
    const name = key("source.bin")
    const stored = await putSealed(name, plaintext, seal)
    const object = await openSealedObject(stored.key, name, seal)

    expect(object.size).toBe(plaintext.byteLength)
    const chunk = 64 * 1024
    for (const [start, end] of [
      [0, 1],
      [chunk - 3, chunk + 3],
      [chunk, 2 * chunk],
      [5, plaintext.byteLength],
      [plaintext.byteLength - 1, plaintext.byteLength],
      [plaintext.byteLength, plaintext.byteLength],
      [1000, 1000],
    ]) {
      const range = await object.range(start, end)
      expect(range.equals(plaintext.subarray(start, end))).toBe(true)
    }
    await expect(object.range(0, plaintext.byteLength + 1)).rejects.toThrow()
  })

  it("will not open one of a document's objects as another", async () => {
    const seal = newDocumentSeal()
    const source = key("source.bin")
    const report = key("report.json.bin")
    const stored = await putSealed(report, Buffer.from('{"report":true}'), seal)

    // Same key, same document, wrong name: the swap the old envelope allowed.
    await expect(getSealed(stored.key, source, seal)).rejects.toThrow()
  })

  it("leaves nothing behind when a stream fails halfway", async () => {
    const seal = newDocumentSeal()
    const name = key("source.bin")

    async function* failing(): AsyncGenerator<Buffer> {
      yield randomBytes(200 * 1024)
      throw new Error("the source went away")
    }

    await expect(putSealedStream(name, failing(), seal)).rejects.toThrow(
      "the source went away"
    )

    const directory = path.dirname(
      path.join(process.cwd(), ".anonify-storage", name)
    )
    const left = await readdir(directory).catch(() => [])
    expect(left).toEqual([])
  })
})

describe("objects sealed before the chunked format", () => {
  it("still open, whole, streamed and by range", async () => {
    const plaintext = randomBytes(100 * 1024)
    const { wrappedKey } = newDocumentSeal()
    const legacy: DocumentSeal = documentSeal({
      encryptionKey: wrappedKey,
      encryptionFormat: null,
    })
    const name = key("source.bin")
    // Written exactly as the pipeline wrote it before: one GCM pass, no name.
    const stored = await putObject(
      name,
      encryptWithDocumentKey(plaintext, wrappedKey)
    )

    expect((await getSealed(stored.key, name, legacy)).equals(plaintext)).toBe(
      true
    )
    expect(
      (await collect(await getSealedStream(stored.key, name, legacy))).equals(
        plaintext
      )
    ).toBe(true)

    const object = await openSealedObject(stored.key, name, legacy)
    expect(
      (await object.range(10, 5000)).equals(plaintext.subarray(10, 5000))
    ).toBe(true)
  })

  it("keep writing the original envelope for the rest of their life", async () => {
    const { wrappedKey } = newDocumentSeal()
    const legacy = documentSeal({
      encryptionKey: wrappedKey,
      encryptionFormat: null,
    })
    const name = key("normalized.json.bin")
    const stored = await putSealedStream(
      name,
      pieces(Buffer.from("{}"), 1),
      legacy
    )

    const raw = await readFile(
      path.join(
        process.cwd(),
        ".anonify-storage",
        stored.key.replace(/^local:/, "")
      )
    )
    expect(raw.subarray(0, 4).equals(CHUNKED_MAGIC)).toBe(false)
    expect((await getSealed(stored.key, name, legacy)).toString()).toBe("{}")
  })

  it("are not read as chunked just because the column says so", async () => {
    const { wrappedKey } = newDocumentSeal()
    const name = key("source.bin")
    const stored = await putObject(
      name,
      encryptWithDocumentKey(Buffer.from("legacy"), wrappedKey)
    )
    await expect(
      getSealed(stored.key, name, { wrappedKey, format: "v1" })
    ).rejects.toThrow()
  })
})

describe("the storage drivers' ranged reads", () => {
  it("reads a range from the filesystem, and refuses one past the end", async () => {
    const bytes = randomBytes(1000)
    const stored = await localDriver.put(key("plain.bin"), bytes)

    expect(
      (await localDriver.getRange(stored.key, 10, 20)).equals(
        bytes.subarray(10, 20)
      )
    ).toBe(true)
    expect(await localDriver.size(stored.key)).toBe(1000)
    await expect(localDriver.getRange(stored.key, 990, 1010)).rejects.toThrow()
  })

  it("uses a range the backend honoured", async () => {
    const bytes = randomBytes(100)
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=10-19")
      return new Response(bytes.subarray(10, 20), { status: 206 })
    })
    vi.stubGlobal("fetch", fetch)

    const range = await vercelBlobDriver.getRange(
      "https://blob.example/x",
      10,
      20
    )
    expect(range.equals(bytes.subarray(10, 20))).toBe(true)
  })

  it("slices the whole object when the backend ignored the range", async () => {
    const bytes = randomBytes(100)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200 }))
    )

    const range = await vercelBlobDriver.getRange(
      "https://blob.example/x",
      10,
      20
    )
    expect(range.equals(bytes.subarray(10, 20))).toBe(true)
  })
})

describe("the streaming budget", () => {
  it("defaults to one mebibyte chunks", () => {
    delete process.env[CHUNK_SIZE_ENV]
    try {
      expect(streamingLimits().chunkBytes).toBe(1024 * 1024)
    } finally {
      process.env[CHUNK_SIZE_ENV] = "64KB"
    }
  })

  it("refuses a chunk size that is not a power of two in range", () => {
    for (const bad of ["100KB", "32KB", "32MB", "nonsense"]) {
      process.env[CHUNK_SIZE_ENV] = bad
      expect(() => streamingLimits()).toThrow(CHUNK_SIZE_ENV)
    }
    process.env[CHUNK_SIZE_ENV] = "64KB"
  })

  it("divides the budget by the documents processing at once", () => {
    const limits = { chunkBytes: 1024 * 1024, memoryBudget: 96 * 1024 * 1024 }
    expect(maxInFlightChunks(limits, 6)).toBe(16)
    expect(maxInFlightChunks(limits, 3)).toBe(32)
  })

  it("refuses a budget that cannot give every document two chunks", () => {
    const limits = { chunkBytes: 1024 * 1024, memoryBudget: 8 * 1024 * 1024 }
    expect(() => maxInFlightChunks(limits, 6)).toThrow(MEMORY_BUDGET_ENV)
  })

  it("chooses its default by deployment profile", () => {
    delete process.env[CHUNK_SIZE_ENV]
    try {
      expect(streamingLimits("demo").memoryBudget).toBe(24 * 1024 * 1024)
      expect(streamingLimits("self-hosted").memoryBudget).toBe(96 * 1024 * 1024)
    } finally {
      process.env[CHUNK_SIZE_ENV] = "64KB"
    }
  })

  it("grows the default budget with the processing concurrency", () => {
    process.env.ANONIFY_BATCH_PROCESSING = "64"
    try {
      // An install that raised concurrency before this existed still starts.
      expect(maxInFlightChunks(streamingLimits("self-hosted"), 64)).toBe(16)
    } finally {
      delete process.env.ANONIFY_BATCH_PROCESSING
    }
  })
})
