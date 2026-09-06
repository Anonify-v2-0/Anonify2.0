import { redactDelimited } from "@/lib/documents/delimited/redact"
import { redactDocx } from "@/lib/documents/docx/redact"
import { redactImage } from "@/lib/documents/image/redact"
import { redactPdf } from "@/lib/documents/pdf/redact"
import { redactEml } from "@/lib/documents/eml/redact"
import { redactPptx } from "@/lib/documents/pptx/redact"
import { redactRtf } from "@/lib/documents/rtf/redact"
import { redactText } from "@/lib/documents/text/redact"
import { redactXlsx } from "@/lib/documents/xlsx/redact"
import {
  buildDelimitedPlan,
  buildDocxPlan,
  buildEmlPlan,
  buildImagePlan,
  buildPdfPlan,
  buildTextPlan,
  buildXlsxPlan,
  type ExportOptions,
} from "@/lib/redaction/apply"
import { outputTypeFor } from "@/lib/documents/formats"
import type { AttachmentAction } from "@/lib/documents/eml/redact"
import type { AttachmentExpectation } from "@/lib/documents/eml/validate"
import { buildSurrogates, type Surrogates } from "@/lib/redaction/surrogates"
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

/**
 * Redacted attachment bytes to substitute into a message, keyed by MIME path.
 *
 * Only ever populated for an `eml`, and only from the children the message was
 * expanded into — see lib/redaction/attachments.ts, which is where the join
 * between the message's parts and the documents they became lives.
 */
export type AttachmentSubstitutions = Record<
  string,
  AttachmentAction & { checksum?: string }
>

export type ExportResult = {
  bytes: Uint8Array
  checksum: string
  extension: string
  mimeType: string
  verification: VerificationReport
  appliedRedactions: number
  /**
   * What this export substituted, and what the reviewer needs to reverse it.
   *
   * Returned rather than written: the vault is the caller's to hand over
   * once, and nothing here decides that it should be stored — because it
   * should not be.
   */
  surrogates: Surrogates
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
  attachments?: AttachmentSubstitutions
}): Promise<ExportResult> {
  const { kind, source, model, redactions, options: requested } = input
  const attachments = input.attachments ?? {}
  const accepted = redactions.filter(
    (redaction) => redaction.status === "accepted"
  )

  // Worked out once, here, rather than by each plan builder: a value's method
  // is a property of the document and the variant, not of the format, and the
  // report has to be able to ask the same object what happened.
  const surrogates = buildSurrogates(accepted, kind, {
    overrides: requested.methods,
    key: requested.valueKey,
  })
  const options: ExportOptions = { ...requested, surrogates }

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
    case "pptx":
      // The same plan a DOCX takes: runs addressed by part, paragraph and
      // index. `w:p/w:r/w:t` and `a:p/a:r/a:t` are one structure under two
      // namespaces, so there is one plan builder and one exporter shape.
      bytes = redactPptx(source, buildDocxPlan(model, accepted, options))
      break
    case "eml":
      bytes = redactEml(
        source,
        buildEmlPlan(model, accepted, options, attachments)
      )
      break
    case "rtf":
      // The same plan the plain-text exporter takes: RTF spans are addressed
      // by their offset in the decoded text, and translating that back to
      // bytes is the redactor's business rather than the reviewer's.
      bytes = redactRtf(source, buildTextPlan(model, accepted, options))
      break
  }

  // Verify against the artifact itself, not against the intent. For a message
  // that carries redacted enclosures this also re-decodes each substituted
  // part and requires it to be exactly the child artifact, byte for byte —
  // the one claim here that a search for absent values cannot make.
  const verification = await verifyExport(
    kind,
    bytes,
    accepted,
    expectationsFor(attachments),
    surrogates.substitutions
  )
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
    surrogates,
  }
}

function imageExtension(mimeType: string | undefined): string {
  return mimeType === "image/jpeg" ? "jpg" : "png"
}

/**
 * The substitutions that carry a checksum, as things to verify.
 *
 * A removal has nothing to check against — the bytes are a sentence this code
 * wrote — and the export report is where it is reported instead.
 */
function expectationsFor(
  attachments: AttachmentSubstitutions
): AttachmentExpectation[] {
  return Object.entries(attachments)
    .filter(([, value]) => value.action === "replace" && value.checksum)
    .map(([partPath, value]) => ({ partPath, checksum: value.checksum! }))
}
