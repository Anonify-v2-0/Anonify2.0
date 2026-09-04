import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { del, head, put } from "@vercel/blob"

/**
 * Storage for encrypted document bytes.
 *
 * On Vercel this is Vercel Blob. Blob URLs are treated as opaque server-side
 * handles: they are never handed to the browser, and everything written here is
 * already AES-256-GCM sealed, so the URL alone discloses nothing.
 *
 * Without a blob token (local development, CI) the same interface is backed by
 * a gitignored directory on disk.
 */

const LOCAL_ROOT = path.join(process.cwd(), ".anonify-storage")

function isLocalDriver(): boolean {
  return !process.env.BLOB_READ_WRITE_TOKEN
}

function localPath(key: string): string {
  const safe = key.replace(/\.\./g, "").replace(/^\/+/, "")
  return path.join(LOCAL_ROOT, safe)
}

export type StoredObject = {
  /** Opaque handle used to read the object back. Never exposed to clients. */
  key: string
  size: number
}

export async function putObject(
  key: string,
  data: Uint8Array
): Promise<StoredObject> {
  if (isLocalDriver()) {
    const file = localPath(key)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, data)
    return { key: `local:${key}`, size: data.byteLength }
  }

  const result = await put(key, Buffer.from(data), {
    access: "public",
    addRandomSuffix: true,
    contentType: "application/octet-stream",
    cacheControlMaxAge: 0,
  })

  return { key: result.url, size: data.byteLength }
}

export async function getObject(key: string): Promise<Buffer> {
  if (key.startsWith("local:")) {
    return readFile(localPath(key.slice("local:".length)))
  }

  const response = await fetch(key, { cache: "no-store" })
  if (!response.ok) {
    throw new Error(`Failed to read stored object (${response.status})`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/** Deletion is idempotent: a missing object is a successful delete. */
export async function deleteObject(key: string): Promise<void> {
  if (key.startsWith("local:")) {
    await rm(localPath(key.slice("local:".length)), { force: true })
    return
  }

  try {
    await del(key)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/not found|404/i.test(message)) throw error
  }
}

export async function objectExists(key: string): Promise<boolean> {
  if (key.startsWith("local:")) {
    try {
      await readFile(localPath(key.slice("local:".length)))
      return true
    } catch {
      return false
    }
  }

  try {
    await head(key)
    return true
  } catch {
    return false
  }
}

export function sourceKey(documentId: string): string {
  return `documents/${documentId}/source.bin`
}

export function processedKey(documentId: string, extension: string): string {
  return `documents/${documentId}/redacted.${extension}.bin`
}

export function renderKey(documentId: string, name: string): string {
  return `documents/${documentId}/render/${name}.bin`
}
