import { extractDelimited } from "@/lib/documents/delimited/extract"
import { extractDocx } from "@/lib/documents/docx/extract"
import { openPackage, readPart } from "@/lib/documents/docx/ooxml"
import { extractPdfText } from "@/lib/documents/pdf/redact"
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

async function haystackFor(
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
  }
}

export async function verifyExport(
  kind: DocumentKind,
  bytes: Uint8Array,
  redactions: Redaction[]
): Promise<VerificationReport> {
  const values = acceptedValues(redactions).filter(
    (value) => value.length >= MIN_VERIFIABLE_LENGTH
  )

  if (values.length === 0 || kind === "image") {
    return { passed: true, leaked: [], checkedValues: values.length }
  }

  const haystack = (await haystackFor(kind, bytes)).toLowerCase()
  const leaked = values.filter((value) =>
    haystack.includes(value.toLowerCase())
  )

  return { passed: leaked.length === 0, leaked, checkedValues: values.length }
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
