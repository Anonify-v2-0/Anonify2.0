import { regionStyle, type ExportOptions } from "@/lib/redaction/apply"
import type { DocumentKind } from "@/types/document"
import {
  REDACTION_CATEGORIES,
  REDACTION_SOURCES,
  REDACTION_STATUSES,
  REDACTION_TYPES,
  type Redaction,
  type RedactionStatus,
} from "@/types/redaction"

/**
 * The export report.
 *
 * A second artifact, delivered alongside the redacted file, that says what the
 * export actually did: how much was removed and of what kind, how it was
 * removed, what the reviewer declined, and the two checksums that tie the
 * statement to a specific source and a specific output.
 *
 * It exists so the claim can be checked by someone who is not holding the
 * original — a reviewer, an auditor, opposing counsel. Which is also why it
 * carries counts and never content: a report that lists what was removed,
 * verbatim, is a leak with a covering letter. `assertReportOmitsValues` makes
 * that a check rather than a promise.
 */

export const REPORT_VERSION = 1

/**
 * How a redaction was applied.
 *
 * `removed` means the content is not in the file. The image styles are
 * recorded separately because they are not the same guarantee: solid replaces
 * the pixels, while blur and pixelate replace them with a function of what was
 * there, and that distinction belongs in the record rather than in a footnote
 * somebody has to remember.
 */
export type RemovalStyle = "removed" | "solid" | "blur" | "pixelate"

export type StyleCounts = Partial<Record<RemovalStyle, number>>

export type CategoryBreakdown = {
  category: string
  count: number
  styles: StyleCounts
}

export type DecisionCounts = {
  total: number
  byCategory: { category: string; count: number }[]
}

export type ExportReport = {
  version: number
  generatedAt: string
  document: {
    id: string
    kind: DocumentKind
    /**
     * No filename, on purpose. A file is regularly named after the person it
     * is about, so the one obviously harmless field is the one most likely to
     * carry a redacted value. The checksums identify the pair instead, and
     * they do it better: a name can be changed after the fact.
     */
    sizeBytes: number
    pageCount: number | null
    sourceChecksum: string
  }
  artifact: {
    checksum: string
    sizeBytes: number
    mimeType: string
    extension: string
    metadataSanitized: boolean
    labelsAdded: boolean
  }
  removed: {
    total: number
    byCategory: CategoryBreakdown[]
    byStyle: StyleCounts
    bySource: { ai: number; user: number; rule: number }
  }
  notRemoved: {
    /** Suggestions the reviewer looked at and turned down. */
    rejected: DecisionCounts
    /** Suggestions never decided either way, which are also still in the file. */
    undecided: DecisionCounts
  }
  verification: {
    passed: boolean
    /** Distinct values the exporter searched the artifact for and did not find. */
    checkedValues: number
  }
  notes: string[]
}

const CATEGORIES = new Set<string>(REDACTION_CATEGORIES)

/**
 * Categories reach the report through a closed vocabulary.
 *
 * A category is a free string in the database — a model can return whatever it
 * likes — and an unrecognised one printed straight into the report would be
 * unreviewed text from the document's own analysis appearing in the artifact
 * that is meant to contain none.
 */
function safeCategory(category: string): string {
  return CATEGORIES.has(category) ? category : "other"
}

/**
 * How this redaction was applied, asked of the same function the image plan
 * uses. Anything else is the report describing an export that did not happen.
 */
function styleFor(
  kind: DocumentKind,
  redaction: Redaction,
  options: ExportOptions
): RemovalStyle {
  if (kind !== "image") return "removed"
  return redaction.boundingBox ? regionStyle(redaction, options) : "solid"
}

function countByCategory(redactions: Redaction[]): DecisionCounts {
  const counts = new Map<string, number>()
  for (const redaction of redactions) {
    const category = safeCategory(redaction.category)
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }

  return {
    total: redactions.length,
    byCategory: sortCounts([...counts].map(([category, count]) => ({
      category,
      count,
    }))),
  }
}

/** Largest first, then alphabetically, so two runs of the same export match. */
function sortCounts<T extends { category: string; count: number }>(
  entries: T[]
): T[] {
  return entries.sort(
    (a, b) => b.count - a.count || a.category.localeCompare(b.category)
  )
}

function withStyle(counts: StyleCounts, style: RemovalStyle): StyleCounts {
  return { ...counts, [style]: (counts[style] ?? 0) + 1 }
}

const WEAKER_STYLES: RemovalStyle[] = ["blur", "pixelate"]

function notesFor(report: Omit<ExportReport, "notes">): string[] {
  const notes = [
    "Counts only. This report never contains the redacted values themselves.",
    "Accepted redactions are removed from the exported file, not covered over. The source document is unchanged.",
  ]

  const weaker = WEAKER_STYLES.filter((style) => report.removed.byStyle[style])
  if (weaker.length > 0) {
    notes.push(
      `${weaker.join(" and ")} replace the original pixels with a function of them, which is a weaker guarantee than solid removal.`
    )
  }

  const stillPresent =
    report.notRemoved.rejected.total + report.notRemoved.undecided.total
  if (stillPresent > 0) {
    notes.push(
      `${stillPresent} suggested ${stillPresent === 1 ? "item was" : "items were"} not accepted and remain in the exported file.`
    )
  }

  return notes
}

export function buildExportReport(input: {
  document: {
    id: string
    kind: DocumentKind
    sizeBytes: number
    pageCount?: number | null
    sourceChecksum: string
  }
  artifact: {
    checksum: string
    sizeBytes: number
    mimeType: string
    extension: string
  }
  options: ExportOptions
  /** Every redaction on the document, whatever its status. */
  redactions: Redaction[]
  verification: { passed: boolean; checkedValues: number }
  generatedAt?: Date
}): ExportReport {
  const byStatus = (status: RedactionStatus) =>
    input.redactions.filter((redaction) => redaction.status === status)

  const accepted = byStatus("accepted")

  const categories = new Map<string, CategoryBreakdown>()
  let byStyle: StyleCounts = {}
  const bySource = { ai: 0, user: 0, rule: 0 }

  for (const redaction of accepted) {
    const category = safeCategory(redaction.category)
    const style = styleFor(input.document.kind, redaction, input.options)

    const entry = categories.get(category) ?? { category, count: 0, styles: {} }
    categories.set(category, {
      category,
      count: entry.count + 1,
      styles: withStyle(entry.styles, style),
    })

    byStyle = withStyle(byStyle, style)
    bySource[redaction.source] += 1
  }

  const skeleton = {
    version: REPORT_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    document: {
      id: input.document.id,
      kind: input.document.kind,
      sizeBytes: input.document.sizeBytes,
      pageCount: input.document.pageCount ?? null,
      sourceChecksum: input.document.sourceChecksum,
    },
    artifact: {
      checksum: input.artifact.checksum,
      sizeBytes: input.artifact.sizeBytes,
      mimeType: input.artifact.mimeType,
      extension: input.artifact.extension,
      metadataSanitized: input.options.sanitizeMetadata,
      labelsAdded: input.options.addLabels,
    },
    removed: {
      total: accepted.length,
      byCategory: sortCounts([...categories.values()]),
      byStyle,
      bySource,
    },
    notRemoved: {
      rejected: countByCategory(byStatus("rejected")),
      undecided: countByCategory(byStatus("suggested")),
    },
    verification: {
      passed: input.verification.passed,
      checkedValues: input.verification.checkedValues,
    },
  }

  return { ...skeleton, notes: notesFor(skeleton) }
}

export function serializeExportReport(report: ExportReport): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  )
}

export class ReportLeakError extends Error {
  constructor(readonly fields: string[]) {
    super("The export report carried document content")
    this.name = "ReportLeakError"
  }
}

/**
 * Every string the report is allowed to have taken from the document's own
 * analysis. Anything outside this set, at a path that is not fixed, is text
 * this file did not choose.
 */
const CLOSED_VOCABULARY = new Set<string>([
  ...REDACTION_CATEGORIES,
  ...REDACTION_TYPES,
  ...REDACTION_SOURCES,
  ...REDACTION_STATUSES,
  "removed",
  "solid",
  "blur",
  "pixelate",
])

/**
 * Fields whose contents this file or the server chose: identifiers, hashes, a
 * timestamp, a MIME type, and the notes, which are English sentences written
 * above with counts interpolated into them.
 *
 * They are skipped rather than matched because the check is a substring one,
 * and prose collides: a four-letter accepted value like "port" occurs inside
 * "report", which would refuse an export over a coincidence. Every other path,
 * including any field added later, is checked.
 */
const AUTHORED_PATHS = new Set([
  "version",
  "generatedAt",
  "document.id",
  "document.kind",
  "document.sourceChecksum",
  "artifact.checksum",
  "artifact.mimeType",
  "artifact.extension",
])

/** Strings short enough to collide by accident are not worth asserting on. */
const MIN_VERIFIABLE_LENGTH = 4

function stringLeaves(value: unknown, path: string): [string, string][] {
  if (typeof value === "string") return [[path, value]]
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => stringLeaves(item, `${path}[${index}]`))
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      stringLeaves(item, path ? `${path}.${key}` : key)
    )
  }
  return []
}

/**
 * The report's own verification step, run before it is stored.
 *
 * It checks the free strings — everything that is not part of the fixed
 * vocabulary above — against the values the export removed. Today none of
 * those fields can carry document text, which is the point: a later change
 * that adds a field holding a sample, a snippet or an "example value" fails
 * here rather than shipping a report that quotes the thing it redacted.
 */
export function assertReportOmitsValues(
  report: ExportReport,
  accepted: Redaction[]
): void {
  const values = [
    ...new Set(
      accepted
        .map((redaction) => redaction.text?.trim())
        .filter(
          (text): text is string =>
            Boolean(text) && text!.length >= MIN_VERIFIABLE_LENGTH
        )
    ),
  ]
  if (values.length === 0) return

  const offending = stringLeaves(report, "")
    .filter(([path]) => !AUTHORED_PATHS.has(path) && !path.startsWith("notes["))
    .filter(([, text]) => !CLOSED_VOCABULARY.has(text))
    .filter(([, text]) =>
      values.some((value) => text.toLowerCase().includes(value.toLowerCase()))
    )
    .map(([path]) => path)

  if (offending.length > 0) {
    throw new ReportLeakError([...new Set(offending)])
  }
}
