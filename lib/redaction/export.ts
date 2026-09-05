import { redactDelimited } from "@/lib/documents/delimited/redact"
import { redactDocx } from "@/lib/documents/docx/redact"
import { redactImage } from "@/lib/documents/image/redact"
import { redactPdf } from "@/lib/documents/pdf/redact"
import { redactRtf } from "@/lib/documents/rtf/redact"
import { redactText } from "@/lib/documents/text/redact"
import { redactXlsx } from "@/lib/documents/xlsx/redact"
import {
  buildDelimitedPlan,
  buildDocxPlan,
  buildImagePlan,
  buildPdfPlan,
  buildTextPlan,
  buildXlsxPlan,
  type ExportOptions,
} from "@/lib/redaction/apply"
import { outputTypeFor } from "@/lib/documents/formats"
import { verifyExport, type VerificationReport } from "@/lib/redaction/validation"
import { sha256 } from "@/lib/storage/integrity"
import type { DocumentKind, NormalizedDocument } from "@/types/document"
import type { Redaction } from "@/types/redaction"

/**
 * The export pipeline.
 *
 * Build the plan from accepted redactions, generate the new document, re-open
 * it and confirm the accepted values are gone, then checksum it. The same
 * inputs produce the same output: nothing here consults a model.
 */

export type ExportResult = {
  bytes: Uint8Array
  checksum: string
  extension: string
  mimeType: string
  verification: VerificationReport
  appliedRedactions: number
}

export class ExportVerificationError extends Error {
  constructor(readonly report: VerificationReport) {
    super("Redacted content survived into the exported document")
    this.name = "ExportVerificationError"
  }
}

export async function exportRedacted(input: {
  kind: DocumentKind
  source: Uint8Array
  model: NormalizedDocument
  redactions: Redaction[]
  options: ExportOptions
  mimeType?: string
}): Promise<ExportResult> {
  const { kind, source, model, redactions, options } = input
  const accepted = redactions.filter(
    (redaction) => redaction.status === "accepted"
  )

  let bytes: Uint8Array

  switch (kind) {
    case "pdf":
      bytes = await redactPdf(source, buildPdfPlan(model, accepted, options))
      break
    case "docx":
      bytes = redactDocx(source, buildDocxPlan(model, accepted, options))
      break
    case "xlsx":
      bytes = await redactXlsx(source, buildXlsxPlan(accepted, options))
      break
    case "image":
      bytes = await redactImage(source, buildImagePlan(model, accepted, options))
      break
    case "csv":
    case "tsv":
      bytes = redactDelimited(
        kind,
        source,
        buildDelimitedPlan(accepted, options)
      )
      break
    case "txt":
      bytes = redactText(source, buildTextPlan(model, accepted, options))
      break
    case "rtf":
      // The same plan the plain-text exporter takes: RTF spans are addressed
      // by their offset in the decoded text, and translating that back to
      // bytes is the redactor's business rather than the reviewer's.
      bytes = redactRtf(source, buildTextPlan(model, accepted, options))
      break
  }

  // Verify against the artifact itself, not against the intent.
  const verification = await verifyExport(kind, bytes, accepted)
  if (!verification.passed) {
    throw new ExportVerificationError(verification)
  }

  const output = outputTypeFor(kind)

  return {
    bytes,
    checksum: sha256(bytes),
    extension: kind === "image" ? imageExtension(input.mimeType) : output.extension,
    mimeType: kind === "image" ? (input.mimeType ?? output.mimeType) : output.mimeType,
    verification,
    appliedRedactions: accepted.length,
  }
}

function imageExtension(mimeType: string | undefined): string {
  return mimeType === "image/jpeg" ? "jpg" : "png"
}
