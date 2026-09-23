import type { Readable } from "node:stream"

import {
  driverForKey,
  selectStorageDriver,
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
    const message = error instanceof Error ? error.message : String(error)
    if (!/not found|404|NoSuchKey/i.test(message)) throw error
  }
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    return await driverForKey(key).exists(key)
  } catch {
    return false
  }
}

/** How the browser should deliver bytes, given the configured backend. */
export function clientUploadMode(): "vercel-blob" | "server-route" {
  return selectStorageDriver().clientUpload
}

export function storageDriverName(): string {
  return selectStorageDriver().name
}

/** Landing path for a browser upload, before ingest re-seals the bytes. */
export function uploadKey(documentId: string, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80)
  return `documents/${documentId}/upload/${safe}`
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
