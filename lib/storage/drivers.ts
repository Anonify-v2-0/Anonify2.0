import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

/**
 * Storage drivers.
 *
 * Three backends, one interface: Vercel Blob for the deployed demo, S3 (MinIO
 * locally) for a self-hosted install, and the filesystem for a clone with
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
  delete: (key: string) => Promise<void>
  exists: (key: string) => Promise<boolean>
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

  async delete(key) {
    await rm(localPath(key), { force: true })
  },

  async exists(key) {
    try {
      await readFile(localPath(key))
      return true
    } catch {
      return false
    }
  },
}

// --- S3 / MinIO ------------------------------------------------------------

const S3_PREFIX = "s3:"

export type S3Config = {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  /** MinIO needs path-style addressing; AWS does not. */
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
    // Anything with a custom endpoint is MinIO-shaped in practice.
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

  if (requested === "local") return localDriver

  if (process.env.BLOB_READ_WRITE_TOKEN) return vercelBlobDriver

  const s3 = s3ConfigFromEnv()
  if (s3) return createS3Driver(s3)

  return localDriver
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
