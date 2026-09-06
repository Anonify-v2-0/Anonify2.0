import { redactDelimited } from "@/lib/documents/delimited/redact"
import { redactDocx } from "@/lib/documents/docx/redact"
import { redactEml } from "@/lib/documents/eml/redact"
import { redactPptx } from "@/lib/documents/pptx/redact"
import { redactRtf } from "@/lib/documents/rtf/redact"
import { redactText } from "@/lib/documents/text/redact"
import { redactXlsx } from "@/lib/documents/xlsx/redact"
import type { ValueReplacement } from "@/lib/documents/shared/text"
import { surrogateCarrier } from "@/lib/redaction/methods"
import { readableText } from "@/lib/redaction/validation"
import {
  CIPHERTEXT_PATTERN,
  decodeValueKey,
  decryptValue,
  inlineCiphertext,
  type TokenVault,
} from "@/lib/redaction/vault"
import { sha256 } from "@/lib/storage/integrity"
import type { DocumentKind } from "@/types/document"

/**
 * Putting the values back.
 *
 * `tokenize` and `encrypt` are only worth offering if the reviewer can
 * actually get back to what they replaced, and "hold onto this vault, then
 * write your own script" is not an answer — it makes the reversal a thing the
 * reviewer has to build, at the moment they most need it to be reliable. So
 * the reversal is a pipeline too: upload the exported document and the vault
 * that came with it, and get the original document back.
 *
 * The direction is the only thing that differs from an export. A redaction
 * replaces a value with a surrogate wherever it occurs; a restore replaces a
 * surrogate with its value wherever it occurs, using the same per-format
 * sweep, so a token in a hidden sheet or a quoted reply comes back exactly the
 * way it went in. Nothing new had to be written per format, which is the point
 * of having made replacement general rather than making masking special.
 *
 * What this cannot do is stated rather than attempted:
 *
 *   - A PDF or an image cannot be restored. The page was rasterised, which is
 *     what made the redaction real; the surrogate on the strip is pixels, and
 *     pixels are not a string to substitute. The vault still says what each
 *     strip stood for, for a human reading it.
 *   - A message's attachments are their own documents and are restored on
 *     their own, with the same vault.
 *   - A pseudonymised value never comes back. There is no mapping, anywhere,
 *     which is the entire difference between `pseudonymize` and `tokenize`.
 */

export type RestoreRefusal =
  | "unsupported-format"
  | "nothing-to-restore"
  | "no-key"

export type RestoreOutcome =
  | {
      ok: true
      bytes: Uint8Array
      /** Distinct surrogates put back, and how many the vault could not open. */
      restored: number
      unresolved: number
      /**
       * Whether the vault names this exact file.
       *
       * Reported rather than enforced. A vault that names a different artifact
       * is usually a reviewer who re-saved the document on the way here, and
       * refusing outright would be wrong more often than it was right — but a
       * restore performed with the wrong vault produces plausible nonsense, so
       * this cannot go unsaid either.
       */
      matchesVault: boolean
    }
  | { ok: false; reason: RestoreRefusal }

/** Formats whose bytes hold characters this pipeline can write back into. */
export function isRestorable(kind: DocumentKind): boolean {
  return surrogateCarrier(kind) === "text"
}

export async function restoreDocument(input: {
  kind: DocumentKind
  bytes: Uint8Array
  vault: TokenVault
}): Promise<RestoreOutcome> {
  const { kind, bytes, vault } = input

  if (!isRestorable(kind)) return { ok: false, reason: "unsupported-format" }

  const key = vault.key ? decodeValueKey(vault.key) : null
  const text = await readableText(kind, bytes)

  const substitutions = new Map<string, string>()
  let unresolved = 0

  // 1. Ciphertexts written inline. These need only the key: the value is in
  //    the document, unreadable rather than absent, which is what `encrypt`
  //    means for a format that can hold text.
  const inline = [...text.matchAll(CIPHERTEXT_PATTERN)]
  if (inline.length > 0 && !key) return { ok: false, reason: "no-key" }

  for (const match of inline) {
    const [, ciphertext] = match
    const marker = inlineCiphertext(ciphertext)
    if (substitutions.has(marker)) continue

    const value = key ? decryptValue(ciphertext, key) : null
    if (value === null) {
      // A wrong key, or a ciphertext this vault was not made for. Left exactly
      // as it is: a half-restored document that looks whole is worse than one
      // that visibly still has work outstanding.
      unresolved += 1
      continue
    }
    substitutions.set(marker, value)
  }

  // 2. The vault's own entries: tokens, and the short references a rasterised
  //    strip used instead of a ciphertext. A reference is here for the reader
  //    rather than for this function — it will not occur in a text document —
  //    but it costs nothing to honour if one does.
  for (const entry of vault.entries) {
    if (substitutions.has(entry.surrogate)) continue

    if (entry.method === "tokenize") {
      substitutions.set(entry.surrogate, entry.value)
      continue
    }

    if (!key) {
      unresolved += 1
      continue
    }

    const value = decryptValue(entry.ciphertext, key)
    if (value === null) {
      unresolved += 1
      continue
    }
    substitutions.set(entry.surrogate, value)
  }

  // A surrogate the vault knows about but the document does not contain is not
  // a failure — a vault covers a whole export, and a message's attachments
  // hold their own share of it — so the sweep is narrowed to what is actually
  // here before anything is rewritten.
  const present: ValueReplacement[] = [...substitutions]
    .filter(([surrogate]) => text.includes(surrogate))
    .map(([surrogate, value]) => ({ value: surrogate, replacement: value }))

  if (present.length === 0) {
    return unresolved > 0
      ? { ok: false, reason: "no-key" }
      : { ok: false, reason: "nothing-to-restore" }
  }

  return {
    ok: true,
    bytes: await rewrite(kind, bytes, present),
    restored: present.length,
    unresolved,
    matchesVault: vault.artifactChecksum === sha256(bytes),
  }
}

/**
 * Runs the format's own redactor with the substitutions reversed.
 *
 * No addressed ranges: a restore has no normalized model to address against,
 * and it does not need one. Every format's safety sweep already replaces a
 * value wherever it occurs, which is exactly the operation a restore is, and
 * reusing it means a token in a speaker note or a hidden sheet is found by the
 * same code that put it there.
 */
async function rewrite(
  kind: DocumentKind,
  bytes: Uint8Array,
  values: ValueReplacement[]
): Promise<Uint8Array> {
  // Metadata is left exactly as the export left it. A restore puts values
  // back; it is not a second chance to sanitize, and re-running the stripper
  // over an already-stripped file would only be able to remove more.
  const ooxml = { runEdits: {}, values, label: null, sanitizeMetadata: false }

  switch (kind) {
    case "txt":
      return redactText(bytes, { ranges: [], values, label: null })
    case "rtf":
      return redactRtf(bytes, { ranges: [], values, label: null })
    case "csv":
    case "tsv":
      return redactDelimited(kind, bytes, {
        cells: [],
        rows: [],
        columns: [],
        values,
        label: null,
      })
    // Never reached: a mailbox is `exportable: false` in the format register.
    // It expanded into the documents this is working on and is not one of
    // them. Named rather than left to the fall-through, so a mailbox arriving
    // here says which invariant broke instead of silently producing nothing.
    case "mbox":
      throw new Error("A mailbox is expanded rather than exported")
    case "docx":
      return redactDocx(bytes, ooxml)
    case "pptx":
      return redactPptx(bytes, ooxml)
    case "xlsx":
      return redactXlsx(bytes, {
        cells: [],
        rows: [],
        columns: [],
        values,
        label: null,
        sanitizeMetadata: false,
      })
    case "eml":
      return redactEml(bytes, {
        bodies: {},
        headers: {},
        filenames: {},
        attachments: {},
        values,
        label: null,
      })
    case "pdf":
    case "image":
      // Refused above; here so a format added later has to say what it does.
      throw new Error(`${kind} cannot be restored`)
  }
}
