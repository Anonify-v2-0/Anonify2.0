import { regionStyle, type ExportOptions } from "@/lib/redaction/apply"
import { presetNarrows, type Preset } from "@/lib/redaction/presets"
import { NO_SURROGATES, type Surrogates } from "@/lib/redaction/surrogates"
import { DOCUMENT_KINDS, type DocumentKind } from "@/types/document"
import {
  REDACTION_CATEGORIES,
  REDACTION_METHODS,
  REDACTION_SOURCES,
  REDACTION_STATUSES,
  REDACTION_TYPES,
  type Redaction,
  type RedactionMethod,
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

/** The name an export takes when the reviewer asked for only one output. */
export const DEFAULT_VARIANT = "redacted"

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

/**
 * How many of each category were masked, pseudonymised, tokenised, encrypted.
 *
 * Separate from `styles`, which says how the *pixels* were treated, because
 * they answer different questions: a style is about how thoroughly something
 * was obscured, a method is about whether anything stands in its place and who
 * can get back to the original. A reader who sees `tokenize` needs to know
 * that a vault exists somewhere; a reader who sees `blur` needs to know the
 * pixels are a function of what was there.
 */
export type MethodCounts = Partial<Record<RedactionMethod, number>>

export type CategoryBreakdown = {
  category: string
  count: number
  styles: StyleCounts
  methods: MethodCounts
}

export type DecisionCounts = {
  total: number
  byCategory: { category: string; count: number }[]
}

/**
 * What happened to one of a message's attachments.
 *
 * "The message was redacted" stopped being a single fact the moment an
 * enclosure could be redacted too, so the report says so per attachment. Named
 * by MIME part path rather than by filename, for the reason the document
 * section gives: a file is regularly named after the person it is about, and
 * the path is the thing that is actually unique anyway.
 */
export type AttachmentReportEntry = {
  partPath: string
  disposition: "redacted" | "carried-through" | "removed"
  /** What the bytes turned out to be, where this pipeline could tell. */
  kind: DocumentKind | null
  /** True for a part the HTML body references; its removal is visible. */
  inline: boolean
  /** The document it became, whose own report sits beside this one. */
  childDocumentId: string | null
  /** SHA-256 of the redacted enclosure now inside the message. */
  artifactChecksum: string | null
  /** Why, when it was not redacted. Written here, never taken from the file. */
  reason: string | null
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
    /**
     * Which output of the review this is.
     *
     * One pass can produce several artifacts — an internally shareable copy
     * with names masked and an external one with them tokenised, say — and a
     * report that did not name which one it described would be the same
     * document from two reports with different counts in them.
     */
    variant: string
  }
  removed: {
    total: number
    byCategory: CategoryBreakdown[]
    byStyle: StyleCounts
    byMethod: MethodCounts
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
  /**
   * What the analysis was asked to look for.
   *
   * A report that says what was removed without saying what was searched for
   * invites the wrong reading: a short list of removals can mean a clean
   * document or a narrow preset, and those are not the same thing at all.
   */
  lookedFor: {
    presetId: string | null
    presetLabel: string | null
    /** `null` when nothing was excluded from the search. */
    categories: string[] | null
    /** False when the chosen preset restricted nothing. */
    narrowed: boolean
  }
  /**
   * One entry per attachment, for a message. Absent for every other kind.
   *
   * A reader has to be able to tell a redacted enclosure from one that was
   * carried through untouched, and both from one that was taken out — and to
   * tell them apart without opening the file.
   */
  attachments?: AttachmentReportEntry[]
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

function withMethod(counts: MethodCounts, method: RedactionMethod): MethodCounts {
  return { ...counts, [method]: (counts[method] ?? 0) + 1 }
}

const WEAKER_STYLES: RemovalStyle[] = ["blur", "pixelate"]

/**
 * What each method did, said in the terms of the bytes rather than of the law.
 *
 * The same discipline the presets are held to, and for the same reason: a
 * reader who is told a document has been "anonymised" believes something about
 * their obligations, and nothing in this pipeline can support that belief.
 * Tokenisation in particular is the tempting one to oversell — it is
 * reversible by whoever holds the vault, which is the opposite of anonymous,
 * and the note has to say so rather than leave it to be inferred.
 */
const METHOD_SENTENCES: Record<RedactionMethod, string> = {
  mask: "masked: the value is gone and nothing stands in its place.",
  pseudonymize:
    "pseudonymized: replaced with a stable surrogate, so equal values are still equal in the export. No mapping back to the originals exists anywhere. This is not anonymisation: a surrogate that is consistent across a file can still be re-identified by joining it against something else.",
  tokenize:
    "tokenized: replaced with a surrogate whose mapping to the original is in the token vault handed to the reviewer. Anyone holding that vault can reverse it, and it is not stored here.",
  encrypt:
    "encrypted: replaced with ciphertext under a key handed to the reviewer and kept nowhere else. Anyone holding that key can reverse it.",
}

/**
 * What each disposition means, said in full. Written out rather than derived,
 * because each one is a different promise and a shared sentence would blur
 * them — "carried through" in particular has to say that nothing inside those
 * files was looked at, which is the caveat this whole section replaces.
 */
const ATTACHMENT_SENTENCES: Record<string, string> = {
  redacted:
    "replaced with its own redacted export, verified separately against the bytes now in the message.",
  "carried-through":
    "in a format Anonify cannot read and was carried through unchanged. Nothing inside it was redacted.",
  removed:
    "removed rather than carried through, because no redacted version of it existed.",
}

function notesFor(report: Omit<ExportReport, "notes">): string[] {
  const substituted = REDACTION_METHODS.filter(
    (method) => method !== "mask" && report.removed.byMethod[method]
  ).length > 0

  const notes = [
    "Counts only. This report never contains the redacted values themselves.",
    substituted
      ? "No accepted value is in the exported file. Where a method other than masking was used, what stands in its place is derived from the value and does not contain it. The source document is unchanged."
      : "Accepted redactions are removed from the exported file, not covered over. The source document is unchanged.",
  ]

  for (const method of REDACTION_METHODS) {
    const count = report.removed.byMethod[method]
    if (!count || method === "mask") continue
    notes.push(`${count} ${count === 1 ? "value was" : "values were"} ${METHOD_SENTENCES[method]}`)
  }

  const weaker = WEAKER_STYLES.filter((style) => report.removed.byStyle[style])
  if (weaker.length > 0) {
    notes.push(
      `${weaker.join(" and ")} replace the original pixels with a function of them, which is a weaker guarantee than solid removal.`
    )
  }

  if (report.lookedFor.narrowed) {
    notes.push(
      "Only one preset's categories were searched for. Anything outside them was never proposed, so its absence from these counts is not evidence it is absent from the file."
    )
  }

  for (const [disposition, sentence] of Object.entries(ATTACHMENT_SENTENCES)) {
    const count = (report.attachments ?? []).filter(
      (entry) => entry.disposition === disposition
    ).length
    if (count === 0) continue
    notes.push(
      count === 1
        ? `1 attachment was ${sentence}`
        : `${count} attachments were ${sentence.replace(/it/g, "them").replace(/its/g, "their")}`
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
  /**
   * What this variant is called, so two reports of one review are telling
   * apart by something other than their counts.
   */
  variant?: string
  /**
   * What the export actually substituted, asked of the object the export
   * used. A report that worked the methods out again could disagree with the
   * artifact it describes, which is the one thing it must never do.
   */
  surrogates?: Surrogates
  /** Every redaction on the document, whatever its status. */
  redactions: Redaction[]
  verification: { passed: boolean; checkedValues: number }
  /** The named detector set the analysis ran with, if any. */
  preset?: Preset | null
  /** One entry per attachment, for a message. Omitted for every other kind. */
  attachments?: AttachmentReportEntry[]
  generatedAt?: Date
}): ExportReport {
  const byStatus = (status: RedactionStatus) =>
    input.redactions.filter((redaction) => redaction.status === status)

  const accepted = byStatus("accepted")

  const surrogates = input.surrogates ?? NO_SURROGATES

  const categories = new Map<string, CategoryBreakdown>()
  let byStyle: StyleCounts = {}
  let byMethod: MethodCounts = {}
  const bySource = { ai: 0, user: 0, rule: 0 }

  for (const redaction of accepted) {
    const category = safeCategory(redaction.category)
    const style = styleFor(input.document.kind, redaction, input.options)
    const method = surrogates.methodOf(redaction)

    const entry = categories.get(category) ?? {
      category,
      count: 0,
      styles: {},
      methods: {},
    }
    categories.set(category, {
      category,
      count: entry.count + 1,
      styles: withStyle(entry.styles, style),
      methods: withMethod(entry.methods, method),
    })

    byStyle = withStyle(byStyle, style)
    byMethod = withMethod(byMethod, method)
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
      variant: input.variant ?? DEFAULT_VARIANT,
    },
    removed: {
      total: accepted.length,
      byCategory: sortCounts([...categories.values()]),
      byStyle,
      byMethod,
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
    lookedFor: {
      presetId: input.preset?.id ?? null,
      presetLabel: input.preset?.label ?? null,
      categories: input.preset?.categories ?? null,
      narrowed: presetNarrows(input.preset ?? null),
    },
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
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
  // The methods, and the name of the default single output. A variant the
  // reviewer named themselves is not in here, which is deliberate — see
  // AUTHORED_PATHS.
  ...REDACTION_METHODS,
  DEFAULT_VARIANT,
  "removed",
  "solid",
  "blur",
  "pixelate",
  // Attachment dispositions and the kinds an attachment can turn out to be.
  "redacted",
  "carried-through",
  ...DOCUMENT_KINDS,
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
  "lookedFor.presetId",
  "lookedFor.presetLabel",
])

/**
 * The same idea for the attachment list, which is an array and so has no fixed
 * paths. Each of these is an identifier, a hash, or a sentence written in
 * lib/redaction/attachments.ts — none of them can carry a filename or a value,
 * which is exactly why the list is keyed by part path.
 */
const AUTHORED_PATTERNS = [
  /^attachments\[\d+\]\.(partPath|childDocumentId|artifactChecksum|reason)$/,
]

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
    .filter(
      ([path]) =>
        !AUTHORED_PATHS.has(path) &&
        !path.startsWith("notes[") &&
        !AUTHORED_PATTERNS.some((pattern) => pattern.test(path))
    )
    .filter(([, text]) => !CLOSED_VOCABULARY.has(text))
    .filter(([, text]) =>
      values.some((value) => text.toLowerCase().includes(value.toLowerCase()))
    )
    .map(([path]) => path)

  if (offending.length > 0) {
    throw new ReportLeakError([...new Set(offending)])
  }
}
