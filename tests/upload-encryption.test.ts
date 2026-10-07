import { createHash, randomBytes } from "node:crypto"
import { readFile, rm, stat } from "node:fs/promises"
import path from "node:path"

import { FatalError } from "workflow"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

/**
 * Uploads sealed in the browser, from the page to the document's source.
 *
 * The browser sealer and the server opener are two implementations of one
 * format, and the only thing keeping them the same format is this file: every
 * boundary a chunked AEAD can get wrong is sealed on one side and opened on
 * the other. After that, ingest is driven for real — the local storage driver,
 * the real envelope, the real sniff — with only the database row faked, and
 * the routes that take the bytes in are called the way a browser calls them.
 */

// --- a database row, and nothing more -----------------------------------------

type Row = Record<string, unknown> & { id: string }
const rows = new Map<string, Row>()

vi.mock("@/lib/database/prisma", () => {
  const where = (args: { where: { id: string; status?: string } }) => {
    const row = rows.get(args.where.id)
    if (!row) return null
    if (args.where.status && row.status !== args.where.status) return null
    return row
  }
  return {
    prisma: {
      document: {
        findUnique: async (args: { where: { id: string } }) => {
          const row = where(args)
          return row ? { ...row } : null
        },
        update: async (args: { where: { id: string }; data: Row }) => {
          const row = where(args)
          if (!row) throw new Error("No record was found for an update")
          Object.assign(row, args.data)
          return { ...row }
        },
        updateMany: async (args: {
          where: { id: string; status?: string }
          data: Row
        }) => {
          const row = where(args)
          if (row) Object.assign(row, args.data)
          return { count: row ? 1 : 0 }
        },
      },
    },
  }
})

const OWNER = "owner_test"

vi.mock("@/lib/security/fingerprint", () => {
  const identity = async () => ({
    ownerKey: OWNER,
    networkKey: "network_test",
    quotaKey: "quota_test",
  })
  return { peekIdentity: identity, getIdentity: identity }
})

vi.mock("@/lib/security/rate-limit", () => ({
  consumeRateLimit: async () => ({
    allowed: true,
    remaining: 100,
    resetAt: new Date(Date.now() + 60_000),
  }),
}))

vi.mock("@/lib/documents/admission", () => ({ admitQueued: async () => {} }))
vi.mock("@/lib/workflows/start-processing", () => ({
  startProcessing: async () => {},
}))

const { MAX_UPLOAD_BYTES } = await import("@/lib/config")
const { runIngest } = await import("@/lib/documents/ingest")
const { isUploadHandleFor, uploadKey } = await import("@/lib/storage/blob")
const {
  ChunkedFormatError,
  ChunkOpener,
  openChunked,
  parseHeader,
  sealChunked,
  sealedSizeOf,
} = await import("@/lib/storage/chunked")
const { decodeUploadKey, sealFileForUpload, sealedUploadSize } =
  await import("@/lib/storage/chunked-web")
const { withDataKey } = await import("@/lib/storage/encryption")
const { documentSeal, getSealed } = await import("@/lib/storage/sealed")
const { collect } = await import("@/lib/storage/streams")
const uploads = await import("@/lib/storage/upload-encryption")
const { describeFailure } = await import("@/lib/workflows/failure")

const STORE = path.join(process.cwd(), ".anonify-storage")

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
  process.env.STORAGE_DRIVER = "local"
})

beforeEach(() => {
  rows.clear()
  delete process.env[uploads.UPLOAD_ENCRYPTION_ENV]
})

const created: string[] = []

afterAll(async () => {
  for (const id of created) {
    await rm(path.join(STORE, "documents", id), {
      recursive: true,
      force: true,
    })
  }
})

function documentId(): string {
  const id = `doc_uploadtest${randomBytes(6).toString("hex")}`
  created.push(id)
  return id
}

/** Plain text a sniff accepts, with a marker to look for in the raw bytes. */
function textFile(bytes: number, marker = "MARKER-7f3a"): Buffer {
  const line = `${marker} Jane Doe lives at 12 Example Street.\n`
  return Buffer.from(
    line.repeat(Math.ceil(bytes / line.length)).slice(0, bytes)
  )
}

async function sealWeb(
  plaintext: Uint8Array,
  key: Uint8Array<ArrayBuffer>,
  logicalKey: string,
  chunkShift: number
): Promise<Buffer> {
  const blob = await sealFileForUpload({
    file: new Blob([new Uint8Array(plaintext)]),
    key,
    logicalKey,
    chunkShift,
  })
  return Buffer.from(await blob.arrayBuffer())
}

// --- the format, across both implementations ----------------------------------

describe("the browser sealer and the server opener agree", () => {
  const shift = 6 // 64-byte chunks: every boundary within a few hundred bytes
  const chunk = 2 ** shift
  const key = new Uint8Array(randomBytes(32))
  const logicalKey = "documents/doc_x/upload/report.txt"

  it.each([0, 1, chunk - 1, chunk, chunk + 1, 3 * chunk, 3 * chunk + 5])(
    "at %i bytes, whole and streamed",
    async (size) => {
      const plaintext = randomBytes(size)
      const sealed = await sealWeb(plaintext, key, logicalKey, shift)

      expect(sealed.byteLength).toBe(sealedSizeOf(size, chunk))
      expect(sealedUploadSize(size, shift)).toBe(sealedSizeOf(size, chunk))
      expect(openChunked(sealed, Buffer.from(key), logicalKey)).toEqual(
        plaintext
      )

      const opener = new ChunkOpener(Buffer.from(key), logicalKey, undefined, {
        chunkShift: shift,
      })
      opener.end(sealed)
      expect(await collect(opener)).toEqual(plaintext)
    }
  )

  it("produces the server sealer's bytes exactly, given its nonce prefix", async () => {
    for (const size of [0, 1, chunk, 2 * chunk + 3]) {
      const plaintext = randomBytes(size)
      const server = sealChunked(plaintext, Buffer.from(key), logicalKey, shift)
      const prefix = parseHeader(server).noncePrefix

      const web = await sealFileForUpload({
        file: new Blob([new Uint8Array(plaintext)]),
        key,
        logicalKey,
        chunkShift: shift,
        random: (bytes) => bytes.set(prefix),
      })

      expect(Buffer.from(await web.arrayBuffer())).toEqual(server)
    }
  })

  it("reports sealing progress up to the whole file", async () => {
    const seen: number[] = []
    await sealFileForUpload({
      file: new Blob([new Uint8Array(randomBytes(3 * chunk))]),
      key,
      logicalKey,
      chunkShift: shift,
      onProgress: (fraction) => seen.push(fraction),
    })
    expect(seen).toEqual([1 / 3, 2 / 3, 1])
  })

  it("refuses a key or chunk size the format does not have", async () => {
    const file = new Blob(["x"])
    await expect(
      sealFileForUpload({
        file,
        key: new Uint8Array(16),
        logicalKey,
        chunkShift: shift,
      })
    ).rejects.toThrow(/32 bytes/)
    await expect(
      sealFileForUpload({ file, key, logicalKey, chunkShift: 25 })
    ).rejects.toThrow(/chunk size/)
  })

  it("decodes the key the reservation returns", () => {
    const minted = uploads.mintUploadKey()
    expect(decodeUploadKey(minted.response.key)).toEqual(
      new Uint8Array(Buffer.from(minted.response.key, "base64"))
    )
  })
})

describe("the opener in front of ingest", () => {
  it("refuses a chunk size other than the one it was told to expect", async () => {
    const key = randomBytes(32)
    const sealed = sealChunked(randomBytes(100), key, "k", 8)
    const opener = new ChunkOpener(key, "k", undefined, { chunkShift: 20 })
    opener.end(sealed)
    await expect(collect(opener)).rejects.toBeInstanceOf(ChunkedFormatError)
  })
})

// --- the upload key --------------------------------------------------------------

describe("the upload key", () => {
  it("is returned raw once and stored only wrapped", async () => {
    const minted = uploads.mintUploadKey()
    expect(minted.response).toMatchObject({
      format: "v1",
      chunkShift: uploads.UPLOAD_CHUNK_SHIFT,
    })
    expect(minted.wrappedKey).not.toContain(minted.response.key)
    const unwrapped = await withDataKey(minted.wrappedKey, (key) =>
      key.toString("base64")
    )
    expect(unwrapped).toBe(minted.response.key)
  })

  it("is a different key every time", () => {
    const keys = new Set(
      Array.from({ length: 5 }, () => uploads.mintUploadKey().response.key)
    )
    expect(keys.size).toBe(5)
  })
})

describe("ANONIFY_UPLOAD_ENCRYPTION", () => {
  it("defaults to optional", () => {
    expect(uploads.uploadEncryptionPolicy()).toBe("optional")
  })

  it("reads required", () => {
    process.env[uploads.UPLOAD_ENCRYPTION_ENV] = "Required"
    expect(uploads.uploadEncryptionPolicy()).toBe("required")
  })

  it("refuses a value it does not know rather than guessing", () => {
    process.env[uploads.UPLOAD_ENCRYPTION_ENV] = "requird"
    expect(() => uploads.uploadEncryptionPolicy()).toThrow(
      uploads.UPLOAD_ENCRYPTION_ENV
    )
  })
})

describe("size ceilings on a sealed upload", () => {
  it("are on the plaintext: exactly the maximum fits, one byte more does not", () => {
    expect(
      uploads.sealedUploadPlaintextBytes(uploads.maxSealedUploadBytes())
    ).toBe(MAX_UPLOAD_BYTES)
    expect(
      uploads.sealedUploadPlaintextBytes(
        uploads.sealedUploadBytes(MAX_UPLOAD_BYTES + 1)
      )
    ).toBe(MAX_UPLOAD_BYTES + 1)
    expect(uploads.maxSealedUploadBytes()).toBeGreaterThan(MAX_UPLOAD_BYTES)
  })

  it("refuse a size no sealer produces", () => {
    expect(uploads.sealedUploadPlaintextBytes(10)).toBeNull()
    // A final chunk with nothing in it, after a full one.
    expect(
      uploads.sealedUploadPlaintextBytes(
        16 + uploads.UPLOAD_CHUNK_BYTES + 16 + 16
      )
    ).toBeNull()
  })
})

// --- whose upload a handle is ---------------------------------------------------

describe("isUploadHandleFor", () => {
  const id = "doc_abc"
  const name = "report.pdf"

  it.each([
    [`local:documents/${id}/upload/${name}`],
    [`s3:documents/${id}/upload/${name}`],
    [`azure:documents/${id}/upload/${name}`],
    [
      `https://store.public.blob.vercel-storage.com/documents/${id}/upload/${name}`,
    ],
    [
      `https://store.public.blob.vercel-storage.com/documents/${id}/upload/report-AbC123xyz.pdf`,
    ],
  ])("accepts %s", (handle) => {
    expect(isUploadHandleFor(handle, id, name)).toBe(true)
  })

  it.each([
    ["another document's upload", `local:documents/doc_other/upload/${name}`],
    ["the document's own source", `local:documents/${id}/source.bin`],
    ["a different driver prefix", `file:documents/${id}/upload/${name}`],
    [
      "a different name on a path driver",
      `s3:documents/${id}/upload/other.pdf`,
    ],
    ["another host", `https://evil.example/documents/${id}/upload/${name}`],
    [
      "plain http",
      `http://store.public.blob.vercel-storage.com/documents/${id}/upload/${name}`,
    ],
    [
      "a nested path",
      `https://store.public.blob.vercel-storage.com/documents/${id}/upload/x/${name}`,
    ],
    [
      "an encoded escape",
      `https://store.public.blob.vercel-storage.com/documents/${id}/upload/..%2F..%2Fdoc_other%2Fsource.bin`,
    ],
    [
      "the bare directory",
      `https://store.public.blob.vercel-storage.com/documents/${id}/upload/`,
    ],
    ["not a handle at all", "hello"],
  ])("refuses %s", (_label, handle) => {
    expect(isUploadHandleFor(handle, id, name)).toBe(false)
  })
})

// --- ingest -----------------------------------------------------------------------

const { putObject, objectExists, getObject } =
  await import("@/lib/storage/blob")

/** A reserved row with an upload key, and the key the browser was given. */
function reserve(name: string, options: { sealed?: boolean } = {}) {
  const id = documentId()
  const minted = options.sealed === false ? null : uploads.mintUploadKey()
  rows.set(id, {
    id,
    originalName: name,
    kind: "txt",
    expiresAt: new Date(Date.now() + 3_600_000),
    mimeType: "text/plain",
    size: 0,
    status: "uploading",
    userFingerprint: OWNER,
    uploadBlobKey: null,
    uploadEncryptionKey: minted?.wrappedKey ?? null,
    uploadFormat: minted?.response.format ?? null,
    sourceBlobKey: null,
  })
  return {
    id,
    pathname: uploadKey(id, name),
    key: minted ? decodeUploadKey(minted.response.key) : null,
    row: () => rows.get(id) as Row,
  }
}

async function land(
  id: string,
  name: string,
  bytes: Uint8Array
): Promise<string> {
  const stored = await putObject(uploadKey(id, name), bytes)
  const row = rows.get(id)!
  row.uploadBlobKey = stored.key
  // What the browser would have reserved: the file's own size, which for a
  // sealed upload is the plaintext inside it. A test about a size mismatch
  // sets it before landing.
  if (row.size === 0) {
    row.size = row.uploadFormat
      ? (uploads.sealedUploadPlaintextBytes(bytes.byteLength) ?? 0)
      : bytes.byteLength
  }
  return stored.key
}

async function ingestFailure(id: string): Promise<string> {
  const error = await runIngest(id).then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).not.toBeNull()
  expect(FatalError.is(error)).toBe(true)
  return (error as Error).message
}

async function sourceExists(id: string): Promise<boolean> {
  try {
    await stat(path.join(STORE, "documents", id, "source.bin"))
    return true
  } catch {
    return false
  }
}

describe("ingesting an upload the browser sealed", { timeout: 30_000 }, () => {
  it("opens it, re-seals it under the data key, and destroys the upload and its key", async () => {
    const doc = reserve("notes.txt")
    // Several upload chunks, so the opener crosses boundaries for real.
    const plaintext = textFile(2 * uploads.UPLOAD_CHUNK_BYTES + 1234)
    const sealed = await sealWeb(
      plaintext,
      doc.key!,
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    const handle = await land(doc.id, "notes.txt", sealed)

    // What sits in storage before ingest is not the file.
    const landed = await readFile(path.join(STORE, doc.pathname))
    expect(landed.includes(Buffer.from("MARKER-7f3a"))).toBe(false)
    expect(landed.includes(plaintext.subarray(0, 64))).toBe(false)

    await expect(runIngest(doc.id)).resolves.toEqual({ kind: "txt" })

    const row = doc.row()
    expect(row.sourceBlobKey).toBeTruthy()
    expect(row.uploadBlobKey).toBeNull()
    expect(row.uploadEncryptionKey).toBeNull()
    expect(row.size).toBe(plaintext.byteLength)
    expect(row.checksum).toBe(
      createHash("sha256").update(plaintext).digest("hex")
    )
    expect(await objectExists(handle)).toBe(false)

    // The source is under the document's own key, not the upload key.
    const source = await getSealed(
      row.sourceBlobKey as string,
      `documents/${doc.id}/source.bin`,
      documentSeal(
        row as unknown as { encryptionKey: string; encryptionFormat: string }
      )
    )
    expect(source).toEqual(plaintext)
    const rawSource = await getObject(row.sourceBlobKey as string)
    expect(() =>
      openChunked(
        rawSource,
        Buffer.from(doc.key!),
        `documents/${doc.id}/source.bin`
      )
    ).toThrow()
  })

  it("returns early on a replay, and the upload key stays gone", async () => {
    const doc = reserve("replay.txt")
    const sealed = await sealWeb(
      textFile(500),
      doc.key!,
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    await land(doc.id, "replay.txt", sealed)
    await runIngest(doc.id)
    const source = doc.row().sourceBlobKey

    await expect(runIngest(doc.id)).resolves.toEqual({ kind: "txt" })
    expect(doc.row().sourceBlobKey).toBe(source)
    expect(doc.row().uploadEncryptionKey).toBeNull()
  })

  it("finishes the cleanup a run died before doing", async () => {
    const doc = reserve("half.txt")
    const sealed = await sealWeb(
      textFile(500),
      doc.key!,
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    const handle = await land(doc.id, "half.txt", sealed)
    // The source was recorded, and then the step died.
    doc.row().sourceBlobKey = "local:documents/elsewhere/source.bin"

    await runIngest(doc.id)

    expect(await objectExists(handle)).toBe(false)
    expect(doc.row().uploadBlobKey).toBeNull()
    expect(doc.row().uploadEncryptionKey).toBeNull()
  })

  it.each([
    [
      "a flipped byte",
      (sealed: Buffer) => {
        sealed[sealed.byteLength - 40] ^= 0x01
        return sealed
      },
    ],
    [
      "a dropped final chunk",
      (sealed: Buffer) =>
        sealed.subarray(0, 16 + 2 * (uploads.UPLOAD_CHUNK_BYTES + 16)),
    ],
    [
      "two chunks swapped",
      (sealed: Buffer) => {
        const size = uploads.UPLOAD_CHUNK_BYTES + 16
        const first = Buffer.from(sealed.subarray(16, 16 + size))
        const second = Buffer.from(sealed.subarray(16 + size, 16 + 2 * size))
        second.copy(sealed, 16)
        first.copy(sealed, 16 + size)
        return sealed
      },
    ],
    [
      "a header that is not ours",
      (sealed: Buffer) => {
        sealed[0] = 0x00
        return sealed
      },
    ],
  ])(
    "refuses %s for good, and stores nothing as the source",
    async (_label, damage) => {
      const doc = reserve("damaged.txt")
      const plaintext = textFile(2 * uploads.UPLOAD_CHUNK_BYTES + 99)
      const sealed = await sealWeb(
        plaintext,
        doc.key!,
        doc.pathname,
        uploads.UPLOAD_CHUNK_SHIFT
      )
      const handle = await land(
        doc.id,
        "damaged.txt",
        Buffer.from(damage(sealed))
      )

      const message = await ingestFailure(doc.id)

      expect(message).toBe(uploads.UNREADABLE_UPLOAD)
      expect(describeFailure(`FatalError: ${message}`)).toMatchObject({
        code: "upload-unreadable",
        retryable: false,
      })
      expect(doc.row().sourceBlobKey).toBeNull()
      expect(await sourceExists(doc.id)).toBe(false)
      // Left for the sweep rather than deleted: it is evidence, and it is
      // ciphertext under a key that dies with the row.
      expect(await objectExists(handle)).toBe(true)
    }
  )

  it("refuses an upload sealed for a different path", async () => {
    const doc = reserve("mine.txt")
    const sealed = await sealWeb(
      textFile(500),
      doc.key!,
      uploadKey("doc_someoneelse", "mine.txt"),
      uploads.UPLOAD_CHUNK_SHIFT
    )
    await land(doc.id, "mine.txt", sealed)
    expect(await ingestFailure(doc.id)).toBe(uploads.UNREADABLE_UPLOAD)
  })

  it("refuses an upload sealed under another key", async () => {
    const doc = reserve("mine.txt")
    const sealed = await sealWeb(
      textFile(500),
      new Uint8Array(randomBytes(32)),
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    await land(doc.id, "mine.txt", sealed)
    expect(await ingestFailure(doc.id)).toBe(uploads.UNREADABLE_UPLOAD)
  })

  it("refuses an upload sealed with another chunk size", async () => {
    const doc = reserve("mine.txt")
    const sealed = await sealWeb(textFile(5000), doc.key!, doc.pathname, 10)
    await land(doc.id, "mine.txt", sealed)
    expect(await ingestFailure(doc.id)).toBe(uploads.UNREADABLE_UPLOAD)
  })

  it("refuses plaintext sent where ciphertext was promised", async () => {
    const doc = reserve("plain.txt")
    await land(doc.id, "plain.txt", textFile(5000))
    expect(await ingestFailure(doc.id)).toBe(uploads.UNREADABLE_UPLOAD)
    expect(await sourceExists(doc.id)).toBe(false)
  })

  it("still sniffs what the sealed bytes really are", async () => {
    const doc = reserve("fake.pdf")
    rows.get(doc.id)!.kind = "pdf"
    const sealed = await sealWeb(
      textFile(500),
      doc.key!,
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    await land(doc.id, "fake.pdf", sealed)
    expect(await ingestFailure(doc.id)).not.toBe(uploads.UNREADABLE_UPLOAD)
  })
})

describe("ingesting a plaintext upload", () => {
  it("reads a row with no upload format exactly as before", async () => {
    const doc = reserve("legacy.txt", { sealed: false })
    const plaintext = textFile(3000)
    await land(doc.id, "legacy.txt", plaintext)

    await expect(runIngest(doc.id)).resolves.toEqual({ kind: "txt" })
    expect(doc.row().size).toBe(plaintext.byteLength)
    expect(doc.row().uploadBlobKey).toBeNull()
  })

  // An Azure SAS cannot sign a length the way S3 does, so ingest is what
  // holds an upload to the size it reserved (#176).
  it("refuses an upload that is not the size it reserved", async () => {
    const plain = reserve("short.txt", { sealed: false })
    plain.row().size = 1000
    await land(plain.id, "short.txt", textFile(3000))
    expect(await ingestFailure(plain.id)).toMatch(
      /not the size that was reserved/
    )
    expect(await sourceExists(plain.id)).toBe(false)

    const sealed = reserve("sealed.txt")
    sealed.row().size = 10
    const bytes = await sealWeb(
      textFile(3000),
      sealed.key!,
      sealed.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    await land(sealed.id, "sealed.txt", bytes)
    expect(await ingestFailure(sealed.id)).toMatch(
      /not the size that was reserved/
    )
  })
})

describe("telling a bad upload from bad weather", () => {
  it("does not turn a storage failure into a verdict", () => {
    expect(uploads.isUnreadableUpload(new Error("read ECONNRESET"))).toBe(false)
    expect(uploads.isUnreadableUpload(new Error("fetch failed"))).toBe(false)
  })

  it("finds a tag failure through a wrapper", () => {
    const inner = new Error("Unsupported state or unable to authenticate data")
    expect(
      uploads.isUnreadableUpload(new Error("Upload failed", { cause: inner }))
    ).toBe(true)
  })
})

// --- the routes that take the bytes in ----------------------------------------------

const localRoute = await import("@/app/api/upload/local/route")
const processRoute = await import("@/app/api/documents/[id]/process/route")

async function postLocal(
  id: string,
  body: Blob,
  name = "file.txt"
): Promise<Response> {
  const form = new FormData()
  form.append("documentId", id)
  form.append("file", body, name)
  return localRoute.POST(
    new Request("http://localhost/api/upload/local", {
      method: "POST",
      body: form,
    })
  )
}

describe("/api/upload/local", { timeout: 30_000 }, () => {
  it("takes a sealed upload of exactly the plaintext ceiling", async () => {
    const doc = reserve("big.txt")
    const response = await postLocal(
      doc.id,
      new Blob([new Uint8Array(uploads.sealedUploadBytes(MAX_UPLOAD_BYTES))])
    )
    expect(response.status).toBe(201)
    // Recorded by the route that wrote it, not left to the client.
    expect(doc.row().uploadBlobKey).toBe(`local:${doc.pathname}`)
  })

  it("refuses a sealed upload one byte of plaintext over", async () => {
    const doc = reserve("big.txt")
    const response = await postLocal(
      doc.id,
      new Blob([
        new Uint8Array(uploads.sealedUploadBytes(MAX_UPLOAD_BYTES + 1)),
      ])
    )
    expect(response.status).toBe(413)
    expect(doc.row().uploadBlobKey).toBeNull()
  })

  it("refuses a size no sealer produces", async () => {
    const doc = reserve("odd.txt")
    const response = await postLocal(doc.id, new Blob([new Uint8Array(20)]))
    expect(response.status).toBe(400)
  })

  it("keeps the plaintext ceiling for a row that did not ask to seal", async () => {
    const doc = reserve("legacy.txt", { sealed: false })
    const over = await postLocal(
      doc.id,
      new Blob([new Uint8Array(MAX_UPLOAD_BYTES + 1)])
    )
    expect(over.status).toBe(413)
  })

  it("stores the ciphertext exactly as it arrived", async () => {
    const doc = reserve("notes.txt")
    const sealed = await sealWeb(
      textFile(3000),
      doc.key!,
      doc.pathname,
      uploads.UPLOAD_CHUNK_SHIFT
    )
    expect(
      (await postLocal(doc.id, new Blob([new Uint8Array(sealed)]))).status
    ).toBe(201)
    expect(await getObject(`local:${doc.pathname}`)).toEqual(sealed)
  })
})

describe("/api/documents/:id/process", () => {
  async function process(id: string, blobUrl: string): Promise<Response> {
    return processRoute.POST(
      new Request(`http://localhost/api/documents/${id}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ blobUrl }),
      }),
      { params: Promise.resolve({ id }) } as never
    )
  }

  it("refuses a handle that is not this document's upload", async () => {
    const victim = reserve("secret.txt")
    await land(victim.id, "secret.txt", Buffer.from("x"))
    const attacker = reserve("secret.txt")

    const response = await process(attacker.id, `local:${victim.pathname}`)

    expect(response.status).toBe(400)
    expect(attacker.row().uploadBlobKey).toBeNull()
    expect(attacker.row().status).toBe("uploading")
  })

  it("prefers the handle the server recorded over the one the client names", async () => {
    const doc = reserve("notes.txt")
    await land(doc.id, "notes.txt", Buffer.from("x"))

    const response = await process(
      doc.id,
      `local:documents/doc_other/upload/notes.txt`
    )

    expect(response.status).toBe(202)
    expect(doc.row().uploadBlobKey).toBe(`local:${doc.pathname}`)
    expect(doc.row().status).toBe("queued")
  })

  it("accepts the document's own upload", async () => {
    const doc = reserve("notes.txt")
    const response = await process(doc.id, `local:${doc.pathname}`)
    expect(response.status).toBe(202)
    expect(doc.row().uploadBlobKey).toBe(`local:${doc.pathname}`)
  })
})
