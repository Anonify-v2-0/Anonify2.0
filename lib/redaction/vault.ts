import { randomBytes } from "node:crypto"

import { openWithKey, sealWithKey } from "@/lib/storage/encryption"
import { REDACTION_CATEGORIES } from "@/types/redaction"

/**
 * The token vault: the artifact that makes `tokenize` and `encrypt` reversible
 * by the reviewer, and by nobody else.
 *
 * It is a separate, labelled download, on the same footing as the redacted
 * file itself — deliberately *not* the export report. The report exists to be
 * shown to someone who was not allowed to see the original, so it carries
 * counts and never content, and `assertReportOmitsValues` enforces that. The
 * vault is the opposite artifact: it exists to be kept by the one person who
 * is allowed to reverse the substitution, and it carries exactly the material
 * that makes that possible. Confusing the two would be the worst outcome
 * available here, so they are different files, produced by different code,
 * with different rules, and the vault is never stored beside the export.
 *
 * Nothing in here needs a hosted service. The key is generated in this process,
 * handed to the reviewer once, and not written to the database or to blob
 * storage — which means Anonify cannot reverse an `encrypt` export, and that is
 * the point rather than a limitation.
 */

export const VAULT_VERSION = 1

const KEY_BYTES = 32

/** How an encrypted value is written into a document that can hold text. */
const CIPHERTEXT_PREFIX = "ENC["
const CIPHERTEXT_SUFFIX = "]"

/**
 * Every inline ciphertext in a string.
 *
 * Base64url has no `[` or `]`, so the delimiters cannot occur inside the
 * payload and the match needs no escaping rules.
 */
export const CIPHERTEXT_PATTERN = /ENC\[([A-Za-z0-9_-]+)\]/g

export type VaultEntry =
  | {
      method: "tokenize"
      /** The surrogate as it appears in the document. */
      surrogate: string
      category: string
      /** What the surrogate stands for. This is the whole point of the file. */
      value: string
    }
  | {
      method: "encrypt"
      surrogate: string
      category: string
      /**
       * The ciphertext, for a surrogate the document could not hold inline —
       * a strip painted onto a rasterised page has room for `ENC_0007` and not
       * for a hundred characters of base64. Reversing it still needs the key.
       */
      ciphertext: string
    }

export type TokenVault = {
  version: number
  generatedAt: string
  documentId: string
  /**
   * The export this vault opens, by checksum.
   *
   * A vault and an artifact that do not belong together produce plausible
   * nonsense rather than an error, so the pair is named here and the restore
   * pipeline checks it.
   */
  artifactChecksum: string
  algorithm: "AES-256-GCM" | null
  /**
   * The key, base64url, or null when nothing was encrypted. Held by the
   * reviewer. Anonify keeps no copy: once the download has been taken, this
   * string is the only way back.
   */
  key: string | null
  entries: VaultEntry[]
  notes: string[]
}

export function newValueKey(): Buffer {
  return randomBytes(KEY_BYTES)
}

export function encodeValueKey(key: Buffer): string {
  return key.toString("base64url")
}

export class InvalidValueKeyError extends Error {
  constructor() {
    super("The key is not a 32-byte base64url value")
    this.name = "InvalidValueKeyError"
  }
}

export function decodeValueKey(text: string): Buffer {
  const key = Buffer.from(text.trim(), "base64url")
  if (key.length !== KEY_BYTES) throw new InvalidValueKeyError()
  return key
}

/**
 * One value, encrypted for substitution into a document.
 *
 * AES-256-GCM with a fresh IV per value, which is why the same name encrypts
 * to a different string each time it occurs. That is the correct behaviour for
 * a cipher and the wrong behaviour for a join key: `encrypt` keeps the field
 * readable-by-the-holder, and `pseudonymize` is the method that keeps it
 * joinable. Offering one that did both would mean a deterministic cipher,
 * which leaks equality to everyone rather than to the key holder.
 */
export function encryptValue(value: string, key: Buffer): string {
  const sealed = sealWithKey(Buffer.from(value, "utf8"), key)
  return sealed.toString("base64url")
}

export function decryptValue(ciphertext: string, key: Buffer): string | null {
  try {
    return openWithKey(Buffer.from(ciphertext, "base64url"), key).toString(
      "utf8"
    )
  } catch {
    // A wrong key, a truncated string, or something that was never a
    // ciphertext. All three mean the same thing to a caller: leave it alone.
    return null
  }
}

/** The inline form written into a document that can carry text. */
export function inlineCiphertext(ciphertext: string): string {
  return `${CIPHERTEXT_PREFIX}${ciphertext}${CIPHERTEXT_SUFFIX}`
}

const VAULT_NOTES = [
  "This file is the only way to reverse the tokenized and encrypted values in the export it names. Anonify does not keep a copy.",
  "It contains original values and the key that recovers them. Treat it as you would the source document, not as you would the export.",
  "Pseudonymized values are not listed: they are not reversible, by design, and no mapping for them exists anywhere.",
]

export function buildVault(input: {
  documentId: string
  artifactChecksum: string
  key: Buffer | null
  entries: VaultEntry[]
  generatedAt?: Date
}): TokenVault {
  return {
    version: VAULT_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    documentId: input.documentId,
    artifactChecksum: input.artifactChecksum,
    algorithm: input.key ? "AES-256-GCM" : null,
    key: input.key ? encodeValueKey(input.key) : null,
    entries: [...input.entries].sort((a, b) =>
      a.surrogate.localeCompare(b.surrogate)
    ),
    notes: VAULT_NOTES,
  }
}

export function serializeVault(vault: TokenVault): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${JSON.stringify(vault, null, 2)}\n`, "utf8")
  )
}

const CATEGORIES = new Set<string>(REDACTION_CATEGORIES)

export class InvalidVaultError extends Error {
  constructor(reason: string) {
    super(`The vault could not be read: ${reason}`)
    this.name = "InvalidVaultError"
  }
}

/**
 * Reads a vault back, for the restore pipeline.
 *
 * Parsed defensively rather than trusted: this file has been out of the tool's
 * hands, and the reviewer is about to upload it back. Every field is checked
 * for shape, unknown categories are dropped to `other`, and anything that does
 * not parse is refused rather than half-applied — a partial restore is a
 * document nobody can reason about.
 */
export function parseVault(bytes: Uint8Array): TokenVault {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new InvalidVaultError("it is not JSON")
  }

  if (!parsed || typeof parsed !== "object") {
    throw new InvalidVaultError("it is not an object")
  }

  const raw = parsed as Record<string, unknown>
  if (raw.version !== VAULT_VERSION) {
    throw new InvalidVaultError(`version ${String(raw.version)} is not supported`)
  }

  const key = typeof raw.key === "string" ? raw.key : null
  if (key !== null) decodeValueKey(key)

  const entries = Array.isArray(raw.entries)
    ? raw.entries.flatMap((entry) => parseEntry(entry))
    : []

  return {
    version: VAULT_VERSION,
    generatedAt: asString(raw.generatedAt) ?? "",
    documentId: asString(raw.documentId) ?? "",
    artifactChecksum: asString(raw.artifactChecksum) ?? "",
    algorithm: key ? "AES-256-GCM" : null,
    key,
    entries,
    notes: VAULT_NOTES,
  }
}

function parseEntry(value: unknown): VaultEntry[] {
  if (!value || typeof value !== "object") return []
  const raw = value as Record<string, unknown>

  const surrogate = asString(raw.surrogate)
  if (!surrogate) return []
  const category = CATEGORIES.has(String(raw.category))
    ? String(raw.category)
    : "other"

  if (raw.method === "tokenize") {
    const original = asString(raw.value)
    return original ? [{ method: "tokenize", surrogate, category, value: original }] : []
  }
  if (raw.method === "encrypt") {
    const ciphertext = asString(raw.ciphertext)
    return ciphertext
      ? [{ method: "encrypt", surrogate, category, ciphertext }]
      : []
  }
  return []
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
