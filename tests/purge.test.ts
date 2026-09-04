import { randomBytes } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import { listDocuments } from "@/lib/documents/listing"
import { purgeStorage } from "@/lib/documents/purge"
import { objectExists, putObject } from "@/lib/storage/blob"

beforeAll(() => {
  process.env.FINGERPRINT_SECRET = randomBytes(32).toString("hex")
})

function bytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value))
}

describe("purging a document's artifacts", () => {
  it("deletes every artifact a document owns, not just the source", async () => {
    const id = `doc_purge_${randomBytes(4).toString("hex")}`

    const source = await putObject(`test/${id}/source.bin`, bytes("source"))
    const upload = await putObject(`test/${id}/upload.bin`, bytes("upload"))
    const processed = await putObject(`test/${id}/processed.bin`, bytes("out"))
    const normalized = await putObject(`test/${id}/normalized.bin`, bytes("{}"))
    const exported = await putObject(`test/${id}/export-1.bin`, bytes("export"))

    const result = await purgeStorage({
      id,
      sourceBlobKey: source.key,
      uploadBlobKey: upload.key,
      processedBlobKey: processed.key,
      normalizedBlobKey: normalized.key,
      exports: [{ blobKey: exported.key }],
    })

    expect(result.storageCleared).toBe(true)
    expect(result.objectsDeleted).toBe(5)

    for (const stored of [source, upload, processed, normalized, exported]) {
      expect(await objectExists(stored.key)).toBe(false)
    }
  })

  it("treats an already-deleted object as deleted", async () => {
    const id = `doc_purge_${randomBytes(4).toString("hex")}`
    const source = await putObject(`test/${id}/source.bin`, bytes("source"))

    const first = await purgeStorage({
      id,
      sourceBlobKey: source.key,
      uploadBlobKey: null,
      processedBlobKey: null,
      normalizedBlobKey: null,
      exports: [],
    })
    const second = await purgeStorage({
      id,
      sourceBlobKey: source.key,
      uploadBlobKey: null,
      processedBlobKey: null,
      normalizedBlobKey: null,
      exports: [],
    })

    expect(first.storageCleared).toBe(true)
    expect(second.storageCleared).toBe(true)
  })

  it("skips keys a document never had", async () => {
    const result = await purgeStorage({
      id: "doc_empty",
      sourceBlobKey: null,
      uploadBlobKey: null,
      processedBlobKey: null,
      normalizedBlobKey: null,
      exports: [],
    })

    expect(result.objectsDeleted).toBe(0)
    expect(result.storageCleared).toBe(true)
  })
})

describe("listing documents", () => {
  it("returns nothing for a caller with no session", async () => {
    // No owner key means no documents — and no database round trip to find out.
    await expect(listDocuments(undefined)).resolves.toEqual([])
  })
})
