import { randomBytes } from "node:crypto"
import { createWriteStream } from "node:fs"
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import type { ReadableStream as WebReadableStream } from "node:stream/web"
import { pipeline } from "node:stream/promises"

import { chain, holdErrors } from "@/lib/storage/streams"
import { perDocumentStreamBytes, streamingLimits } from "@/lib/storage/streaming"

/**
 * Storage drivers.
 *
 * Three backends, one interface: Vercel Blob for the deployed demo, S3-compatible
 * storage for a self-hosted install, and the filesystem for a clone with
 * nothing configured at all. Everything above this file works in stored keys
 * and never learns which one answered.
 *
 * A stored key is either an absolute URL (Vercel Blob hands one back) or a
 * `driver:path` handle. Keys are persisted, so the prefix is also what lets a
 * document written under one backend still be read after the configuration
 * changes — the driver is chosen per key on read, not globally.
 */

export const STORAGE_DRIVERS = ["vercel-blob", "s3", "local"] as const

export type StorageDriverName = (typeof STORAGE_DRIVERS)[number]

export type StoredObject = {
  /** Opaque handle used to read the object back. Never exposed to clients. */
  key: string
  size: number
}

export type StorageDriver = {
  name: StorageDriverName
  /**
   * How the browser gets bytes in. Vercel Blob issues a scoped token and the
   * browser uploads directly; everything else goes through our own route.
   */
  clientUpload: "vercel-blob" | "server-route"
  put: (key: string, data: Uint8Array) => Promise<StoredObject>
  get: (key: string) => Promise<Buffer>
  /**
   * The object as a stream, for a reader that should never hold all of it.
   * Takes the stored handle, like `get`.
   */
  getStream: (key: string) => Promise<Readable>
  /**
   * Bytes `[start, end)` of the object — half-open, like every other range in
   * this codebase, whatever the backend's own convention.
   *
   * Every driver answers this, and a backend that cannot honour a range falls
   * back to reading the whole object and slicing it. Only the efficiency
   * varies; callers never have to know which backend they are talking to.
   */
  getRange: (key: string, start: number, end: number) => Promise<Buffer>
  /**
   * Writes a stream without holding more of it than the streaming budget
   * allows. Takes a logical key and returns the handle, like `put`.
   */
  putStream: (key: string, body: Readable) => Promise<StoredObject>
  /** The stored size in bytes, without reading the object. */
  size: (key: string) => Promise<number>
  delete: (key: string) => Promise<void>
  exists: (key: string) => Promise<boolean>
}

/** Counts what passes through, for a `StoredObject.size` nobody precomputed. */
class ByteCounter extends Transform {
  bytes = 0

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void
  ): void {
    this.bytes += chunk.byteLength
    callback(null, chunk)
  }
}

/** Pipes a body through a counter; see `chain` for why not plain `pipe`. */
function counted(body: Readable): ByteCounter {
  return chain(body, new ByteCounter())
}

/**
 * The requested slice of a response that may or may not have honoured the
 * range. A backend that ignored it sent the whole object, which is still an
 * answer — just a more expensive one.
 */
function sliceIfWhole(
  bytes: Buffer,
  honoured: boolean,
  start: number,
  end: number
): Buffer {
  const slice = honoured ? bytes : bytes.subarray(start, end)
  if (slice.byteLength !== end - start) {
    throw new Error(
      `Ranged read returned ${slice.byteLength} bytes, expected ${end - start}`
    )
  }
  return slice
}

function assertRange(start: number, end: number): void {
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start
  ) {
    throw new RangeError(`Invalid byte range ${start}-${end}`)
  }
}

// --- local filesystem ------------------------------------------------------

const LOCAL_PREFIX = "local:"
const LOCAL_ROOT = path.join(process.cwd(), ".anonify-storage")

function localPath(key: string): string {
  const relative = key.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length) : key
  // Keys are server-generated, but a traversal here would escape the store.
  const safe = relative.replace(/\.\./g, "").replace(/^[/\\]+/, "")
  return path.join(LOCAL_ROOT, safe)
}

export const localDriver: StorageDriver = {
  name: "local",
  clientUpload: "server-route",

  async put(key, data) {
    const file = localPath(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, data)
    return { key: `${LOCAL_PREFIX}${key}`, size: data.byteLength }
  },

  async get(key) {
    return readFile(localPath(key))
  },

  async getStream(key) {
    // Opened eagerly so a missing object is an error here, where the caller
    // is waiting for it, rather than an event on a stream nobody reads yet.
    const handle = await open(localPath(key), "r")
    return handle.createReadStream({
      highWaterMark: streamingLimits().chunkBytes,
    })
  },

  async getRange(key, start, end) {
    assertRange(start, end)
    const handle = await open(localPath(key), "r")
    try {
      const out = Buffer.alloc(end - start)
      let read = 0
      while (read < out.byteLength) {
        const { bytesRead } = await handle.read(
          out,
          read,
          out.byteLength - read,
          start + read
        )
        if (bytesRead === 0) break
        read += bytesRead
      }
      return sliceIfWhole(out.subarray(0, read), true, start, end)
    } finally {
      await handle.close()
    }
  },

  async putStream(key, body) {
    holdErrors(body)
    const file = localPath(key)
    await mkdir(path.dirname(file), { recursive: true })
    // Written beside the destination and renamed into place, so a stream that
    // fails halfway leaves no half an object under the real name.
    const partial = `${file}.${randomBytes(6).toString("hex")}.partial`
    const counter = new ByteCounter()
    try {
      await pipeline(
        body,
        counter,
        createWriteStream(partial, {
          highWaterMark: streamingLimits().chunkBytes,
        })
      )
      await rename(partial, file)
    } catch (error) {
      await rm(partial, { force: true })
      throw error
    }
    return { key: `${LOCAL_PREFIX}${key}`, size: counter.bytes }
  },

  async size(key) {
    return (await stat(localPath(key))).size
  },

  async delete(key) {
    await rm(localPath(key), { force: true })
  },

  async exists(key) {
    try {
      await stat(localPath(key))
      return true
    } catch {
      return false
    }
  },
}

// --- S3-compatible storage -------------------------------------------------

const S3_PREFIX = "s3:"

export type S3Config = {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  /** Self-hosted S3 services commonly need path-style addressing; AWS does not. */
  forcePathStyle: boolean
}

export function s3ConfigFromEnv(): S3Config | null {
  const bucket = process.env.S3_BUCKET?.trim()
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim()

  if (!bucket || !accessKeyId || !secretAccessKey) return null

  const endpoint = process.env.S3_ENDPOINT?.trim() || undefined

  return {
    bucket,
    region: process.env.S3_REGION?.trim() || "us-east-1",
    endpoint,
    accessKeyId,
    secretAccessKey,
    // Custom S3-compatible endpoints generally use path-style addressing.
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE
      ? process.env.S3_FORCE_PATH_STYLE !== "false"
      : Boolean(endpoint),
  }
}

function objectPath(key: string): string {
  return key.startsWith(S3_PREFIX) ? key.slice(S3_PREFIX.length) : key
}

export function createS3Driver(config: S3Config): StorageDriver {
  // Imported lazily so a deployment that never touches S3 does not pay for it.
  const client = import("@aws-sdk/client-s3").then(
    ({ S3Client }) =>
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
      })
  )

  return {
    name: "s3",
    clientUpload: "server-route",

    async put(key, data) {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3")
      await (await client).send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: objectPath(key),
          Body: Buffer.from(data),
          ContentType: "application/octet-stream",
        })
      )
      return { key: `${S3_PREFIX}${key}`, size: data.byteLength }
    },

    async get(key) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3")
      const result = await (await client).send(
        new GetObjectCommand({ Bucket: config.bucket, Key: objectPath(key) })
      )

      const body = result.Body
      if (!body) throw new Error(`Stored object is empty: ${key}`)
      return Buffer.from(await body.transformToByteArray())
    },

    async getStream(key) {
      const { GetObjectCommand } = await import("@aws-sdk/client-s3")
      const result = await (await client).send(
        new GetObjectCommand({ Bucket: config.bucket, Key: objectPath(key) })
      )
      const body = result.Body
      if (!body) throw new Error(`Stored object is empty: ${key}`)
      // In Node the SDK's body is a Readable with helpers mixed in.
      return body as unknown as Readable
    },

    async getRange(key, start, end) {
      assertRange(start, end)
      if (end === start) return Buffer.alloc(0)
      const { GetObjectCommand } = await import("@aws-sdk/client-s3")
      const result = await (await client).send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: objectPath(key),
          // HTTP ranges are inclusive at both ends.
          Range: `bytes=${start}-${end - 1}`,
        })
      )
      const body = result.Body
      if (!body) throw new Error(`Stored object is empty: ${key}`)
      const bytes = Buffer.from(await body.transformToByteArray())
      return sliceIfWhole(bytes, Boolean(result.ContentRange), start, end)
    },

    async putStream(key, body) {
      const { Upload } = await import("@aws-sdk/lib-storage")
      // S3 will not take a part under 5 MiB, so that is the part size, and
      // the number of parts in flight is what this document's share of the
      // streaming budget holds.
      const partSize = 5 * 1024 * 1024
      const queueSize = Math.max(
        1,
        Math.floor(perDocumentStreamBytes() / partSize)
      )
      const counter = counted(body)
      const upload = new Upload({
        client: await client,
        params: {
          Bucket: config.bucket,
          Key: objectPath(key),
          Body: counter,
          ContentType: "application/octet-stream",
        },
        partSize,
        queueSize,
        leavePartsOnError: false,
      })
      await upload.done()
      return { key: `${S3_PREFIX}${key}`, size: counter.bytes }
    },

    async size(key) {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3")
      const result = await (await client).send(
        new HeadObjectCommand({ Bucket: config.bucket, Key: objectPath(key) })
      )
      if (typeof result.ContentLength !== "number") {
        throw new Error(`Stored object has no length: ${key}`)
      }
      return result.ContentLength
    },

    async delete(key) {
      const { DeleteObjectCommand } = await import("@aws-sdk/client-s3")
      await (await client).send(
        new DeleteObjectCommand({ Bucket: config.bucket, Key: objectPath(key) })
      )
    },

    async exists(key) {
      const { HeadObjectCommand } = await import("@aws-sdk/client-s3")
      try {
        await (await client).send(
          new HeadObjectCommand({ Bucket: config.bucket, Key: objectPath(key) })
        )
        return true
      } catch {
        return false
      }
    },
  }
}

// --- Vercel Blob -----------------------------------------------------------

export const vercelBlobDriver: StorageDriver = {
  name: "vercel-blob",
  clientUpload: "vercel-blob",

  async put(key, data) {
    const { put } = await import("@vercel/blob")
    const result = await put(key, Buffer.from(data), {
      access: "public",
      addRandomSuffix: true,
      contentType: "application/octet-stream",
      cacheControlMaxAge: 0,
    })
    return { key: result.url, size: data.byteLength }
  },

  async get(key) {
    const response = await fetch(key, { cache: "no-store" })
    if (!response.ok) {
      throw new Error(`Failed to read stored object (${response.status})`)
    }
    return Buffer.from(await response.arrayBuffer())
  },

  async getStream(key) {
    const response = await fetch(key, { cache: "no-store" })
    if (!response.ok || !response.body) {
      throw new Error(`Failed to read stored object (${response.status})`)
    }
    return Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)
  },

  async getRange(key, start, end) {
    assertRange(start, end)
    if (end === start) return Buffer.alloc(0)
    const response = await fetch(key, {
      cache: "no-store",
      // HTTP ranges are inclusive at both ends.
      headers: { range: `bytes=${start}-${end - 1}` },
    })
    if (!response.ok) {
      throw new Error(`Failed to read stored object (${response.status})`)
    }
    // 206 is the range; 200 is a server that ignored it and sent everything.
    const bytes = Buffer.from(await response.arrayBuffer())
    return sliceIfWhole(bytes, response.status === 206, start, end)
  },

  async putStream(key, body) {
    const { put } = await import("@vercel/blob")
    const counter = counted(body)
    const result = await put(key, counter, {
      access: "public",
      addRandomSuffix: true,
      contentType: "application/octet-stream",
      cacheControlMaxAge: 0,
    })
    return { key: result.url, size: counter.bytes }
  },

  async size(key) {
    const { head } = await import("@vercel/blob")
    return (await head(key)).size
  },

  async delete(key) {
    const { del } = await import("@vercel/blob")
    await del(key)
  },

  async exists(key) {
    const { head } = await import("@vercel/blob")
    try {
      await head(key)
      return true
    } catch {
      return false
    }
  },
}

// --- selection -------------------------------------------------------------

export function configuredDriverName(): StorageDriverName | null {
  const raw = process.env.STORAGE_DRIVER?.trim().toLowerCase()
  if (!raw) return null
  return (STORAGE_DRIVERS as readonly string[]).includes(raw)
    ? (raw as StorageDriverName)
    : null
}

/**
 * The driver new objects are written with.
 *
 * Explicit configuration wins. Otherwise it is inferred from what is actually
 * available, so a fresh clone with nothing set still works — on the filesystem.
 */
export function selectStorageDriver(): StorageDriver {
  const requested = configuredDriverName()

  if (process.env.STORAGE_DRIVER && !requested) {
    throw new Error(
      `STORAGE_DRIVER must be one of: ${STORAGE_DRIVERS.join(", ")}`
    )
  }

  if (requested === "vercel-blob") {
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      throw new Error(
        "STORAGE_DRIVER=vercel-blob needs BLOB_READ_WRITE_TOKEN."
      )
    }
    return vercelBlobDriver
  }

  if (requested === "s3") {
    const config = s3ConfigFromEnv()
    if (!config) {
      throw new Error(
        "STORAGE_DRIVER=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY."
      )
    }
    return createS3Driver(config)
  }

  if (requested === "local") {
    refuseLocalOnVercel()
    return localDriver
  }

  if (process.env.BLOB_READ_WRITE_TOKEN) return vercelBlobDriver

  const s3 = s3ConfigFromEnv()
  if (s3) return createS3Driver(s3)

  refuseLocalOnVercel()
  return localDriver
}

/**
 * The filesystem fallback is a convenience for a fresh clone, and a trap on
 * Vercel.
 *
 * Nothing about it announces itself: a deployment with no storage configured
 * picks this driver, writes land on a filesystem that is read-only outside
 * /tmp, and what does succeed belongs to one function instance and is gone by
 * the next request. Worse, `clientUpload: "server-route"` sends the browser's
 * bytes through our own route, where Vercel caps a request body at 4.5 MB — so
 * the visible symptom is a 413 on a 12 MB PDF, which points at the upload and
 * not at the missing configuration that caused it.
 *
 * Failing here turns all of that into one sentence naming the variable to set.
 */
function refuseLocalOnVercel(): void {
  if (!process.env.VERCEL) return
  throw new Error(
    "The local filesystem driver cannot be used on Vercel: the filesystem is " +
      "read-only and per-instance, and uploads through this app's own route " +
      "are capped at 4.5 MB. Set BLOB_READ_WRITE_TOKEN (connect a Vercel Blob " +
      "store to the project), or configure S3 with S3_BUCKET, S3_ACCESS_KEY_ID " +
      "and S3_SECRET_ACCESS_KEY."
  )
}

/**
 * The driver that can read a given key. Chosen from the key's own prefix, so
 * objects written before a configuration change remain readable.
 */
export function driverForKey(key: string): StorageDriver {
  if (key.startsWith(LOCAL_PREFIX)) return localDriver
  if (key.startsWith(S3_PREFIX)) {
    const config = s3ConfigFromEnv()
    if (!config) {
      throw new Error(
        "This document is stored in S3, but S3 is no longer configured."
      )
    }
    return createS3Driver(config)
  }
  return vercelBlobDriver
}
