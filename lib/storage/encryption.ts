import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

import { requiredEnv } from "@/lib/config"

/**
 * Envelope encryption for stored document bytes.
 *
 * Every document gets its own random 256-bit data key. The payload is sealed
 * with AES-256-GCM (authenticated), and the data key is itself sealed with the
 * server-held master key. Keys are random — never derived from IP addresses,
 * MAC addresses or any other observed client property.
 */

const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32

function parseMasterKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64")

  if (key.length !== KEY_BYTES) {
    throw new Error(
      "ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)"
    )
  }
  return key
}

function masterKey(): Buffer {
  return parseMasterKey(requiredEnv("ENCRYPTION_KEY"))
}

/** Seals `plaintext` with `key`, returning iv || tag || ciphertext. */
export function sealWithKey(plaintext: Uint8Array, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
}

/** Opens an iv || tag || ciphertext payload. Throws if authentication fails. */
export function openWithKey(sealed: Uint8Array, key: Buffer): Buffer {
  const buffer = Buffer.from(sealed)
  if (buffer.length < IV_BYTES + TAG_BYTES) {
    throw new Error("Ciphertext is too short to be valid")
  }

  const iv = buffer.subarray(0, IV_BYTES)
  const tag = buffer.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
  const body = buffer.subarray(IV_BYTES + TAG_BYTES)

  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

export type EncryptedPayload = {
  ciphertext: Buffer
  /** The document's data key, sealed under the master key, base64-encoded. */
  wrappedKey: string
}

export function encryptDocument(plaintext: Uint8Array): EncryptedPayload {
  const dataKey = randomBytes(KEY_BYTES)
  const ciphertext = sealWithKey(plaintext, dataKey)
  const wrappedKey = sealWithKey(dataKey, masterKey()).toString("base64")
  // The plaintext data key does not outlive this function.
  dataKey.fill(0)
  return { ciphertext, wrappedKey }
}

export function decryptDocument(
  ciphertext: Uint8Array,
  wrappedKey: string
): Buffer {
  const dataKey = openWithKey(Buffer.from(wrappedKey, "base64"), masterKey())
  try {
    return openWithKey(ciphertext, dataKey)
  } finally {
    dataKey.fill(0)
  }
}

/** Encrypts a derived artifact (an export, say) under an existing data key. */
export function encryptWithDocumentKey(
  plaintext: Uint8Array,
  wrappedKey: string
): Buffer {
  const dataKey = openWithKey(Buffer.from(wrappedKey, "base64"), masterKey())
  try {
    return sealWithKey(plaintext, dataKey)
  } finally {
    dataKey.fill(0)
  }
}
