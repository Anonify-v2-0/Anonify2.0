import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { openPackage, readPart } from "@/lib/documents/ooxml/package"
import { extractPdfText } from "@/lib/documents/pdf/redact"
import {
  emlHaystack,
  verifyAttachmentSubstitutions,
  type AttachmentCheck,
  type AttachmentExpectation,
} from "@/lib/documents/eml/validate"
import { extractRtf } from "@/lib/documents/rtf/extract"
import { extractText } from "@/lib/documents/text/extract"
import { extractXlsx } from "@/lib/documents/xlsx/extract"
import { acceptedValues } from "@/lib/redaction/model"
import type { DocumentKind } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * Export verification.
 *
 * The exporters are tested, but a redaction system should not take its own word
 * for it on the file it is about to hand back. Every export is re-opened and
 * read the way an adversary would — extracted text, raw XML parts, every sheet
 * including hidden ones — and any accepted value still present fails the export
 * rather than being delivered.
 */

export type VerificationReport = {
  passed: boolean
  /** Values that survived, for the operator's log. Never returned to a client. */
  leaked: string[]
  checkedValues: number
  /**
   * Per-attachment equality checks, for a message carrying redacted
   * enclosures. Empty for every other export.
   *
   * A separate result because it answers a separate question. Everything else
   * here asks whether something that should be gone is absent, which a
   * substitution can satisfy while carrying the wrong file; this asks whether
   * something that should be present is exactly right.
   */
  attachments: AttachmentCheck[]
}

/** Values short enough to appear coincidentally are not worth asserting on. */
const MIN_VERIFIABLE_LENGTH = 4

function textOfXmlParts(bytes: Uint8Array): string {
  const pkg = openPackage(bytes)
  return Object.keys(pkg.files)
    .filter((name) => name.endsWith(".xml") || name.endsWith(".rels"))
    .map((name) => readPart(pkg, name) ?? "")
    .join("\n")
}

/**
 * Everything in an exported document that is readable as text.
 *
 * Named and exported because two callers need exactly this: the verifier,
 * which searches it for values that should be gone, and the restore pipeline,
 * which searches it for the surrogates it is about to put values back into.
 * They are the same question asked from opposite ends, and a second definition
 * of "what counts as readable" would be a second place for one of them to miss
 * a hidden sheet.
 */
export async function readableText(
  kind: DocumentKind,
  bytes: Uint8Array
): Promise<string> {
  switch (kind) {
    case "pdf":
      return extractPdfText(bytes)
    case "docx":
      // Read the parts directly rather than the rendered document: text that
      // survives in a header, a comment or a footnote is still a leak.
      return textOfXmlParts(bytes)
    case "xlsx": {
      const { document } = await extractXlsx("verify", bytes)
      const cells = (document.sheets ?? [])
        .flatMap((sheet) => sheet.cells.map((cell) => cell.value ?? ""))
        .join("\n")
      return `${cells}\n${textOfXmlParts(bytes)}`
    }
    case "image":
      // Pixels carry no strings; the image suite verifies these by sampling.
      return ""
    case "csv":
    case "tsv": {
      // Re-parsed rather than searched as a string: if the export produced
      // something that no longer parses as a grid, that is a failure in its own
      // right, and a value hiding in a field the parser cannot reach would not
      // be found by reading the file as one blob.
      const { document } = extractDelimited("verify", kind, bytes)
      const cells = (document.sheets ?? [])
        .flatMap((sheet) => sheet.cells.map((cell) => cell.value ?? ""))
        .join("\n")
      return cells
    }
    case "txt": {
      const { text } = extractText("verify", bytes)
      return text
    }
    case "pptx":
      // Every part, not the slides: a value surviving in the speaker notes, on
      // a layout or on the master is still in the file somebody opens.
      return textOfXmlParts(bytes)
    case "eml":
      // Reparsed twice: once by this pipeline's own parser, and once by an
      // independent MIME library. A message that only our parser can read is
      // not a message anybody received.
      return emlHaystack(bytes)
    case "rtf": {
      // Re-parsed, which also proves the export is still RTF: a file that no
      // longer opens would throw here rather than pass for want of a match.
      const { text } = extractRtf("verify", bytes)
      return text
    }
    // Never reached: a mailbox is `exportable: false` in the format register.
    // It expanded into the documents this is working on and is not one of
    // them. Named rather than left to the fall-through, so a mailbox arriving
    // here says which invariant broke instead of silently producing nothing.
    case "mbox":
      throw new Error("A mailbox is expanded rather than read back")
  }
}

export async function verifyExport(
  kind: DocumentKind,
  bytes: Uint8Array,
  redactions: Redaction[],
  /** Attachment parts whose bytes were replaced, and what they must now be. */
  expectations: AttachmentExpectation[] = [],
  /**
   * Strings this export wrote into the document in place of values.
   *
   * They are taken out of the haystack before it is searched, and the reason
   * is a false positive rather than a false negative. A surrogate is text this
   * pipeline authored — `PERSON_014`, or a base64url ciphertext — and a long
   * ciphertext can contain, by coincidence, the four letters of a short
   * accepted value. Searching what we wrote for what the document said would
   * refuse a perfectly correct export over an accident of encoding.
   *
   * Excising them cannot hide a real leak: none of these strings is derived
   * from the value in a way that could reproduce it. A surrogate is a counter,
   * and a ciphertext is indistinguishable from random without the key.
   */
  substitutions: string[] = []
): Promise<VerificationReport> {
  const values = acceptedValues(redactions).filter(
    (value) => value.length >= MIN_VERIFIABLE_LENGTH
  )

  // Run first and unconditionally: a message can have no accepted redactions
  // of its own and still carry three substituted attachments, and the early
  // return below would have shipped those unchecked.
  const attachments = await verifyAttachmentSubstitutions(bytes, expectations)
  const substituted = attachments.every((check) => check.passed)

  if (values.length === 0 || kind === "image") {
    return {
      passed: substituted,
      leaked: [],
      checkedValues: values.length,
      attachments,
    }
  }

  const haystack = withoutSubstitutions(
    (await readableText(kind, bytes)).toLowerCase(),
    substitutions
  )
  const leaked = values.filter((value) =>
    haystack.includes(value.toLowerCase())
  )

  return {
    passed: leaked.length === 0 && substituted,
    leaked,
    checkedValues: values.length,
    attachments,
  }
}

/**
 * The haystack with every string this export authored blanked out.
 *
 * Replaced with spaces rather than deleted, so removing a substitution cannot
 * bring two halves of the surrounding text together and manufacture a value
 * that was never in the file.
 */
function withoutSubstitutions(
  haystack: string,
  substitutions: string[]
): string {
  let result = haystack

  for (const substitution of substitutions) {
    const needle = substitution.toLowerCase()
    if (needle.length === 0) continue

    let index = result.indexOf(needle)
    while (index !== -1) {
      result =
        result.slice(0, index) +
        " ".repeat(needle.length) +
        result.slice(index + needle.length)
      index = result.indexOf(needle, index + needle.length)
    }
  }

  return result
}

/** Confirms an exported DOCX still opens and still has its structure. */
export function docxOpens(bytes: Uint8Array): boolean {
  try {
    const { document } = extractDocx("verify", bytes)
    return document.pages.length > 0
  } catch {
    return false
  }
}
