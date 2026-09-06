import { newRedactionId } from "@/lib/documents/ids"
import { isRedactionMethod } from "@/lib/redaction/methods"
import type { Detection, Redaction, RedactionType } from "@/types/redaction"

/**
 * The redaction model.
 *
 * Detections are proposals; redactions are the record of what the document
 * should become. Keeping them as separate objects is what makes the human step
 * real: nothing is applied because a detector or a model said so, only because
 * a redaction reached `accepted`.
 */

export function detectionType(detection: Detection): RedactionType {
  if (detection.boundingBox && detection.category === "face") return "face"
  if (detection.boundingBox) return "region"
  if (detection.worksheet && detection.row && detection.column) return "cell"
  return "text"
}

export function detectionToRedaction(
  documentId: string,
  detection: Detection,
  source: Redaction["source"] = "ai"
): Redaction {
  return {
    id: newRedactionId(),
    documentId,
    type: detectionType(detection),
    source,
    category: detection.category,
    confidence: detection.confidence,
    // AI and rule output always lands as a suggestion. Only a person accepts.
    status: "suggested",
    page: detection.page,
    text: detection.text,
    start: detection.start,
    end: detection.end,
    boundingBox: detection.boundingBox,
    worksheet: detection.worksheet,
    row: detection.row,
    column: detection.column,
    reason: detection.reason,
    metadata: detection.global ? { global: true } : undefined,
  }
}

/** Shape accepted by Prisma when persisting a redaction. */
export function toDatabaseRow(redaction: Redaction) {
  return {
    id: redaction.id,
    documentId: redaction.documentId,
    source: redaction.source,
    type: redaction.type,
    category: redaction.category,
    confidence: redaction.confidence ?? null,
    status: redaction.status,
    method: redaction.method ?? null,
    page: redaction.page ?? null,
    text: redaction.text ?? null,
    startOffset: redaction.start ?? null,
    endOffset: redaction.end ?? null,
    worksheet: redaction.worksheet ?? null,
    row: redaction.row ?? null,
    column: redaction.column ?? null,
    reason: redaction.reason ?? null,
    ruleId: redaction.ruleId ?? null,
    metadata: {
      ...(redaction.metadata ?? {}),
      ...(redaction.boundingBox
        ? { boundingBox: redaction.boundingBox }
        : {}),
    },
  }
}

type DatabaseRedaction = {
  id: string
  documentId: string
  source: string
  type: string
  category: string
  confidence: number | null
  status: string
  method?: string | null
  page: number | null
  text: string | null
  startOffset: number | null
  endOffset: number | null
  worksheet: string | null
  row: number | null
  column: number | null
  reason: string | null
  ruleId: string | null
  metadata: unknown
}

export function fromDatabaseRow(row: DatabaseRedaction): Redaction {
  const metadata = (row.metadata ?? {}) as Record<string, unknown> & {
    boundingBox?: Redaction["boundingBox"]
  }

  return {
    id: row.id,
    documentId: row.documentId,
    type: row.type as Redaction["type"],
    source: row.source as Redaction["source"],
    category: row.category,
    confidence: row.confidence ?? undefined,
    status: row.status as Redaction["status"],
    // Anything the column does not recognise is read as no method at all,
    // which resolves to masking. A stored string is not a promise.
    method: isRedactionMethod(row.method) ? row.method : undefined,
    page: row.page ?? undefined,
    text: row.text ?? undefined,
    start: row.startOffset ?? undefined,
    end: row.endOffset ?? undefined,
    boundingBox: metadata.boundingBox,
    worksheet: row.worksheet ?? undefined,
    row: row.row ?? undefined,
    column: row.column ?? undefined,
    reason: row.reason ?? undefined,
    ruleId: row.ruleId ?? undefined,
    metadata,
  }
}

export function isAccepted(redaction: Redaction): boolean {
  return redaction.status === "accepted"
}

/** Values a redaction contributes to the package-wide safety sweep. */
/**
 * Redactions that name a position rather than carry content.
 *
 * A column redaction's `text` is the column's *header* — "Email", "Account" —
 * because that is what a reviewer needs to see to decide about it. It is a
 * label for the target, not a value to be erased, and the exporter removes such
 * a column by position while deliberately keeping its name.
 */
const POSITIONAL_TYPES = new Set<Redaction["type"]>(["row", "column"])

/**
 * Values to sweep for wherever they appear, which is how a name hiding in a
 * hidden sheet or a cached formula result gets removed along with the cell a
 * reviewer actually looked at.
 *
 * Positional redactions are excluded, and the reason is worth stating: their
 * text is a header the exporter keeps on purpose, so including it asked the
 * export to remove a string it had just been told to preserve. Verification
 * then found that string still present and refused to deliver the file — every
 * spreadsheet export failed the moment a column suggestion was accepted, which
 * is to say every spreadsheet the model looked at.
 */
export function acceptedValues(redactions: Redaction[]): string[] {
  const values = new Set<string>()
  for (const redaction of redactions) {
    if (!isAccepted(redaction)) continue
    if (POSITIONAL_TYPES.has(redaction.type)) continue
    const text = redaction.text?.trim()
    if (text && text.length >= 2) values.add(text)
  }
  return [...values]
}
