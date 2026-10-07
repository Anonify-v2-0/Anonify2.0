import type { Readable } from "node:stream"

import {
  driverForKey,
  isMissingObject,
  selectStorageDriver,
  type ClientUploadMode,
  type PresignedUpload,
  type StoredObject,
} from "@/lib/storage/drivers"

/**
 * Storage for encrypted document bytes.
 *
 * The backend is configuration — Vercel Blob, S3-compatible storage, or the local
 * filesystem — and nothing above this file knows which one answered. Blob URLs
 * and object keys are treated as opaque server-side handles: they are never
 * handed to the browser, and everything written here is already AES-256-GCM
 * sealed, so a leaked handle discloses nothing.
 *
 * Writes go to the configured driver; reads go to the driver named by the key,
 * so documents survive a configuration change rather than becoming unreachable.
 */

export type { StoredObject }

export async function putObject(
  key: string,
  data: Uint8Array
): Promise<StoredObject> {
  return selectStorageDriver().put(key, data)
}

export async function getObject(key: string): Promise<Buffer> {
  return driverForKey(key).get(key)
}

/** Writes a stream; see `StorageDriver.putStream`. */
export async function putObjectStream(
  key: string,
  body: Readable
): Promise<StoredObject> {
  return selectStorageDriver().putStream(key, body)
}

export async function getObjectStream(key: string): Promise<Readable> {
  return driverForKey(key).getStream(key)
}

/** Bytes `[start, end)` of a stored object. */
export async function getObjectRange(
  key: string,
  start: number,
  end: number
): Promise<Buffer> {
  return driverForKey(key).getRange(key, start, end)
}

export async function objectSize(key: string): Promise<number> {
  return driverForKey(key).size(key)
}

/** Deletion is idempotent: a missing object is a successful delete. */
export async function deleteObject(key: string): Promise<void> {
  try {
    await driverForKey(key).delete(key)
  } catch (error) {
    if (!isMissingObject(error)) throw error
  }
}

/**
 * Deletes several objects, each through the driver its handle names, in as
 * few requests as each backend allows (#170). Idempotent like `deleteObject`;
 * returns the keys that could not be deleted rather than throwing.
 */
export async function deleteObjects(
  keys: string[]
): Promise<{ failed: string[] }> {
  const byDriver = new Map<string, string[]>()
  const failed: string[] = []
  for (const key of keys) {
    let name: string
    try {
      name = driverForKey(key).name
    } catch {
      // A key whose backend is no longer configured cannot be deleted here.
      failed.push(key)
      continue
    }
    byDriver.set(name, [...(byDriver.get(name) ?? []), key])
  }
  for (const group of byDriver.values()) {
    try {
      failed.push(...(await driverForKey(group[0]).deleteMany(group)).failed)
    } catch {
      failed.push(...group)
    }
  }
  return { failed }
}

/** Whether the configured backend answers; see `StorageDriver.probe`. */
export async function probeStorage(): Promise<void> {
  await selectStorageDriver().probe()
}

/**
 * When browsers upload straight to the bucket, whether its CORS rules let
 * them (#185); see `StorageDriver.probeUploadCors`. `skipped` when they do
 * not upload straight to it, or the driver cannot tell.
 */
export async function probeUploadCors(
  origin: string
): Promise<"allowed" | "unreadable" | "skipped"> {
  const driver = selectStorageDriver()
  if (driver.clientUpload !== "s3-presigned" || !driver.probeUploadCors) {
    return "skipped"
  }
  return driver.probeUploadCors(origin)
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    return await driverForKey(key).exists(key)
  } catch {
    return false
  }
}

/** How the browser should deliver bytes, given the configured backend. */
export function clientUploadMode(): ClientUploadMode {
  return selectStorageDriver().clientUpload
}

/**
 * A presigned PUT for one upload, from a driver configured to hand them out.
 * Null when the configured backend does not.
 */
export async function presignUpload(
  key: string,
  size: number
): Promise<PresignedUpload | null> {
  const driver = selectStorageDriver()
  if (driver.clientUpload !== "s3-presigned" || !driver.presignUpload) {
    return null
  }
  return driver.presignUpload(key, size)
}

export function storageDriverName(): string {
  return selectStorageDriver().name
}

/** Landing path for a browser upload, before ingest re-seals the bytes. */
export function uploadKey(documentId: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80)
  return `documents/${documentId}/upload/${safe}`
}

/**
 * Whether a stored handle is this document's own upload.
 *
 * The browser tells `/process` where its bytes landed, and ingest then reads
 * that handle and **deletes** it. Trusted as sent, that was a way to point a
 * document at any object in the store — another document's source, say — and
 * have ingest remove it. So the handle has to be the path the reservation
 * fixed: exactly, for the drivers whose handle is the path, and by prefix for
 * Vercel Blob, whose URL carries a random suffix the server does not choose.
 */
export function isUploadHandleFor(
  handle: string,
  documentId: string,
  filename: string
): boolean {
  const path = uploadKey(documentId, filename)
  if (
    handle === `local:${path}` ||
    handle === `s3:${path}` ||
    handle === `azure:${path}`
  ) {
    return true
  }

  let url: URL
  try {
    url = new URL(handle)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  if (!url.hostname.endsWith(".blob.vercel-storage.com")) return false
  if (url.search || url.hash) return false

  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return false
  }
  const prefix = `/documents/${documentId}/upload/`
  const name = pathname.slice(prefix.length)
  return pathname.startsWith(prefix) && name.length > 0 && !name.includes("/")
}

export function sourceKey(documentId: string): string {
  return `documents/${documentId}/source.bin`
}

/** The normalized model: the document's text, so sealed like the source. */
export function normalizedKey(documentId: string): string {
  return `documents/${documentId}/normalized.json.bin`
}

export function processedKey(documentId: string, extension: string): string {
  return `documents/${documentId}/redacted.${extension}.bin`
}

/**
 * One generated export. Written and read through this one function so the
 * path a reader binds the object to is the path it was sealed under.
 */
export function artifactKey(
  documentId: string,
  artifactId: string,
  extension: string
): string {
  return processedKey(documentId, `${artifactId}.${extension}`)
}

/** The export report that accompanies one generated artifact. */
export function reportKey(documentId: string, artifactId: string): string {
  return `documents/${documentId}/report.${artifactId}.json.bin`
}

/**
 * The token vault for one artifact, written only by a batch export.
 *
 * Sealed under the same per-document key as the artifact it opens, and purged
 * by the same sweep, because it is the one derived artifact that carries the
 * values back. See lib/redaction/deliver.ts for why a single export never
 * writes one.
 */
export function vaultKey(documentId: string, artifactId: string): string {
  return `documents/${documentId}/vault.${artifactId}.json.bin`
}

export function renderKey(documentId: string, name: string): string {
  return `documents/${documentId}/render/${name}.bin`
}
