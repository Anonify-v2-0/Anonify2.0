import type { Readable } from "node:stream"

import { MAX_UPLOAD_BYTES } from "@/lib/config"
import {
  ChunkedFormatError,
  ChunkOpener,
  plaintextSizeOf,
  sealedSizeOf,
} from "@/lib/storage/chunked"
import { newDataKey, withDataKey } from "@/lib/storage/encryption"
import { chain } from "@/lib/storage/streams"
import { streamingLimits } from "@/lib/storage/streaming"

/**
 * Uploads that are ciphertext before they leave the browser.
 *
 * Every byte Anonify stores is sealed, except — until this — the upload
 * itself: from the moment it landed until ingest re-sealed it and deleted it,
 * `documents/:id/upload/<name>` was the file in the clear, in a bucket, on
 * disk, or as a public Vercel Blob object. Ingest only runs once a document is
 * admitted, so in a large batch that was minutes, and for a run that never
 * started it was until the expiry sweep.
 *
 * Now the browser seals the file into the v1 chunked envelope
 * (lib/storage/chunked-web.ts) under an **upload key** the server mints at
 * reservation:
 *
 *   1. reservation mints a random 256-bit key, wraps it under the master key
 *      on the row (`uploadEncryptionKey`), records `uploadFormat`, and returns
 *      the raw key once;
 *   2. the browser seals, and both transports carry and store only
 *      ciphertext;
 *   3. ingest opens the upload with that key, and everything after — sniff,
 *      hash, re-seal under a fresh data key — is what it always was;
 *   4. ingest deletes the upload and nulls the wrapped key.
 *
 * Why a key of its own rather than the document's data key: the data key
 * never leaves the server, and stays minted at ingest, so nothing after ingest
 * changes. The owner's browser already holds the plaintext, so a key that only
 * protects its own transient upload tells it nothing new, and a leaked upload
 * key opens one short-lived object — not the source, the model or an export.
 *
 * Whether an upload is sealed is recorded on the row, never guessed from the
 * bytes: a plaintext file can begin with `ANFY` like anything else can.
 */

/** The envelope a browser seals its upload in. */
export const UPLOAD_FORMATS = ["v1"] as const

export type UploadFormat = (typeof UPLOAD_FORMATS)[number]

/**
 * 1 MiB, fixed, rather than the server's configured chunk size.
 *
 * The configured size is what the server seals its own objects with, and is
 * free to change; an upload is sealed by a client, and ingest refuses any
 * other size (see `ChunkOpener`'s `chunkShift` option), so what the opener in
 * front of ingest holds is bounded here rather than by what an upload claims.
 * Fixed also makes every size ceiling below exact: the sealed size of a file
 * is a function of its length alone.
 */
export const UPLOAD_CHUNK_SHIFT = 20
export const UPLOAD_CHUNK_BYTES = 2 ** UPLOAD_CHUNK_SHIFT

export const UPLOAD_ENCRYPTION_ENV = "ANONIFY_UPLOAD_ENCRYPTION"

/**
 * Whether plaintext uploads are still accepted.
 *
 * `optional` (the default) keeps the plaintext path for a client that does not
 * ask for an upload key — an API script, `pnpm smoke`, a tab opened before the
 * deploy. `required` refuses those at reservation, once the clients that talk
 * to an install have been updated.
 */
export type UploadEncryptionPolicy = "optional" | "required"

export function uploadEncryptionPolicy(): UploadEncryptionPolicy {
  const raw = process.env[UPLOAD_ENCRYPTION_ENV]?.trim().toLowerCase()
  if (!raw || raw === "optional") return "optional"
  if (raw === "required") return "required"
  // Refused rather than defaulted: somebody who typed "requird" believes
  // plaintext uploads are off.
  throw new Error(
    `${UPLOAD_ENCRYPTION_ENV} must be "optional" or "required", got "${raw}"`
  )
}

/**
 * A browser can only seal in a secure context — WebCrypto's `subtle` does not
 * exist on a page served over plain HTTP from anywhere but localhost — so that
 * is the likeliest reason a current client asks for none, and the message
 * says so.
 */
export const PLAINTEXT_UPLOAD_REFUSED =
  "This instance only accepts uploads encrypted in the browser. That needs the page to be served over HTTPS (or from localhost) and an up-to-date client; reload the page and try again."

/** The recorded format, or null for a plaintext upload. Unknown is refused. */
export function uploadFormatOf(
  recorded: string | null | undefined
): UploadFormat | null {
  if (recorded === null || recorded === undefined) return null
  if (recorded === "v1") return "v1"
  throw new Error(`Unknown upload format "${recorded}"`)
}

/** What the reservation stores, and what it returns to the browser once. */
export type MintedUploadKey = {
  wrappedKey: string
  response: { format: UploadFormat; key: string; chunkShift: number }
}

export function mintUploadKey(): MintedUploadKey {
  // The same shape as a data key — 32 random bytes wrapped under the master
  // key — and deliberately not the same key.
  const { dataKey, wrappedKey } = newDataKey()
  const key = dataKey.toString("base64")
  dataKey.fill(0)
  return {
    wrappedKey,
    response: { format: "v1", key, chunkShift: UPLOAD_CHUNK_SHIFT },
  }
}

// --- sizes ----------------------------------------------------------------------

/** The largest object a sealed upload can be: `MAX_UPLOAD_BYTES` of plaintext. */
export function maxSealedUploadBytes(): number {
  return sealedSizeOf(MAX_UPLOAD_BYTES, UPLOAD_CHUNK_BYTES)
}

/** The object size a sealed upload of `plaintextSize` bytes must have. */
export function sealedUploadBytes(plaintextSize: number): number {
  return sealedSizeOf(plaintextSize, UPLOAD_CHUNK_BYTES)
}

/**
 * The plaintext a sealed upload of this stored size holds, or null when no
 * sealer could have produced that size. The ceiling everywhere is on the
 * plaintext, so a file of exactly `MAX_UPLOAD_BYTES` is accepted on every path
 * however its tags add up.
 */
export function sealedUploadPlaintextBytes(storedSize: number): number | null {
  try {
    return plaintextSizeOf(storedSize, UPLOAD_CHUNK_BYTES)
  } catch (error) {
    if (error instanceof ChunkedFormatError) return null
    throw error
  }
}

// --- ingest ---------------------------------------------------------------------

/**
 * What ingest throws when an upload does not open. Worded for the failure
 * table in lib/workflows/failure.ts, which matches on it; the tag failure or
 * format error underneath can carry nothing worth showing.
 */
export const UNREADABLE_UPLOAD = "Uploaded file could not be decrypted"

/**
 * The stored upload as a stream of authenticated plaintext.
 *
 * Bound to the upload's logical key — the path it was reserved under, from
 * the row, never from the handle — so an object from another document or
 * another path does not open here even if somebody manages to point a row at
 * it.
 */
export async function openUploadStream(
  stored: Readable,
  wrappedKey: string,
  logicalKey: string
): Promise<Readable> {
  const opener = await withDataKey(
    wrappedKey,
    (key) =>
      new ChunkOpener(key, logicalKey, streamingLimits().chunkBytes, {
        chunkShift: UPLOAD_CHUNK_SHIFT,
      })
  )
  return chain(stored, opener)
}

/**
 * Whether an error means the upload's bytes are wrong rather than that
 * reading them failed.
 *
 * A tag that does not verify, a truncated object, a header this code does not
 * read: the same bytes fail the same way every time, so these are verdicts,
 * not weather. A storage timeout on the way through is not, and must stay
 * retryable. The cause chain is walked because a storage SDK may wrap the
 * body stream's error in one of its own.
 */
export function isUnreadableUpload(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof ChunkedFormatError) return true
    if (
      current instanceof Error &&
      /unable to authenticate data/i.test(current.message)
    ) {
      return true
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return false
}
