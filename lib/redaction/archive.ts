import { Zip, ZipDeflate, zipSync } from "fflate"

import type { MailboxRebuildFailure } from "@/lib/documents/mbox/rebuild"
import type { BatchOutput } from "@/lib/redaction/batch-layout"
import {
  REPORT_VERSION,
  type ExportReport,
  type MethodCounts,
  type RemovalStyle,
  type StyleCounts,
} from "@/lib/redaction/report"

/**
 * The batch archive.
 *
 * One export per document, delivered as a single file, because a reviewer who
 * uploaded eight documents wants eight results and not eight downloads. Each
 * document keeps its own artifact and its own report — nothing is merged, and
 * nothing about one document's redactions is inferable from another's.
 */

export type ArchiveFile = { name: string; bytes: Uint8Array }

/**
 * Two files in a batch can perfectly well be called `invoice.pdf`, and a zip
 * with the same entry twice loses one of them silently. Suffixed rather than
 * renamed wholesale, so the name the user recognises survives.
 */
export function uniqueNames<T extends { name: string }>(files: T[]): T[] {
  const taken = new Set<string>()

  return files.map((file) => {
    if (!taken.has(file.name)) {
      taken.add(file.name)
      return file
    }

    const dot = file.name.lastIndexOf(".")
    const base = dot === -1 ? file.name : file.name.slice(0, dot)
    const extension = dot === -1 ? "" : file.name.slice(dot)

    let counter = 2
    let candidate = `${base}-${counter}${extension}`
    while (taken.has(candidate)) {
      counter += 1
      candidate = `${base}-${counter}${extension}`
    }

    taken.add(candidate)
    return { ...file, name: candidate }
  })
}

export function buildArchive(files: ArchiveFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const file of uniqueNames(files)) {
    entries[file.name] = file.bytes
  }
  // Level 6 for the same reason the OOXML writer uses it: the inputs are mostly
  // already-compressed document formats, so a higher setting buys almost
  // nothing and costs real time on a large batch.
  return zipSync(entries, { level: 6 })
}

/**
 * A file for a streamed archive: bytes already in hand, or a stream opened
 * when the archive reaches it.
 */
export type StreamedArchiveFile =
  | ArchiveFile
  | { name: string; open: () => Promise<AsyncIterable<Uint8Array>> }

/**
 * The archive, written as it is read.
 *
 * `buildArchive` holds every file and then the whole zip — a batch of fifty
 * exports, twice. This opens each file only when the archive reaches it and
 * compresses it a piece at a time, so what is held is a piece in and what it
 * compressed to. The same level, for the same reason; the entries carry data
 * descriptors instead of sizes up front, which every unzip reads.
 *
 * A file that fails while it streams fails the archive: its entry is already
 * half-written, and a zip with a truncated entry is not a smaller archive but
 * a broken one.
 */
export async function* streamArchive(
  files: StreamedArchiveFile[]
): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, data) => {
    if (error) failure = error
    else out.push(data)
  })

  function* drain(): Generator<Uint8Array> {
    if (failure) throw failure
    while (out.length > 0) yield out.shift() as Uint8Array
  }

  for (const file of uniqueNames(files)) {
    const entry = new ZipDeflate(file.name, { level: 6 })
    zip.add(entry)
    if ("bytes" in file) {
      entry.push(file.bytes, true)
    } else {
      for await (const piece of await file.open()) {
        entry.push(piece)
        yield* drain()
      }
      entry.push(new Uint8Array(0), true)
    }
    yield* drain()
  }

  zip.end()
  yield* drain()
}

/** Why a document in the batch is not in the archive. */
export type SkipReason =
  | "not-ready"
  | "verification-failed"
  | "rate-limited"
  | "archive-full"
  | "export-failed"
  /** The reviewer stopped the run before this document was reached. */
  | "cancelled"
  /**
   * A mailbox, which is the batch rather than a file in it. Named rather than
   * left out silently, and named as itself rather than as "not ready": a
   * reviewer counting nine hundred messages and one missing mailbox needs to
   * know the mailbox was never going to be there.
   */
  | "container"
  /**
   * Processing failed, or the document was refused when its container
   * expanded — over the allowance, too large, not a format this reads. The
   * batch view carries the sentence; the report carries only that it is not
   * here.
   */
  | "failed"
  /**
   * A mailbox none of whose messages could be included, so there was nothing
   * to rebuild. Its messages are each named with their own reason.
   */
  | "empty-container"

/**
 * Which top-level upload a file went back into, and where in it.
 *
 * Ids and part paths only — `["msg-3", "0.2"]` is the second part of the
 * fourth message — because this report names nothing a document chose. In the
 * original format the file is inside that upload; in the processed layout it
 * is in that upload's folder, at the place the path describes.
 */
export type ContainerPlacement = {
  documentId: string
  path: string[]
}

/**
 * A mailbox, rebuilt: how many of its messages went back in and which did not.
 *
 * "897 of 900" is the sentence the reviewer needs, and the three are named by
 * message number and document id with the reason each was left out — never
 * silently dropped, because nobody counts nine hundred messages by hand.
 */
export type ContainerSummary = {
  documentId: string
  kind: "mbox"
  /**
   * SHA-256 of the rebuilt mailbox as it was verified and delivered. Null when
   * it was not delivered: nothing to include, or it failed verification.
   */
  checksum: string | null
  verified: boolean
  /**
   * Which check a mailbox that failed verification failed, and at which
   * message when it concerns one; null when it passed or was never built.
   * "Withheld" alone leaves a reviewer unable to tell a changed export from a
   * separator that would have carried a value.
   */
  failure: { check: MailboxRebuildFailure; message: number | null } | null
  messages: {
    total: number
    included: number
    leftOut: { message: number; documentId: string; reason: SkipReason }[]
  }
}

export type BatchReport = {
  version: number
  generatedAt: string
  batchId: string
  /** What was downloaded: see lib/redaction/batch-layout.ts. */
  output: BatchOutput
  documents: {
    documentId: string
    sourceChecksum: string
    artifactChecksum: string
    /**
     * The upload this file went back into, or null for a file that was an
     * upload of its own.
     */
    container: ContainerPlacement | null
    removed: number
    /**
     * How the values in this file were treated, and whether the archive
     * carries a vault that reverses it.
     *
     * A batch of files handled different ways is exactly the case where a
     * reader cannot assume: one document's counts say nothing about the next
     * one's, and "12 documents redacted" would hide that three of them are
     * reversible by whoever holds the zip.
     */
    methods: MethodCounts
    vault: boolean
  }[]
  /**
   * Documents that are not in the archive, and why. A batch report that lists
   * only what worked would let a document quietly go missing, which is the one
   * failure mode a bundle of redacted files must not have.
   */
  skipped: { documentId: string; reason: SkipReason }[]
  /** Every mailbox that was rebuilt, or would have been. */
  containers: ContainerSummary[]
  totals: {
    documentsIncluded: number
    removed: number
    byCategory: { category: string; count: number }[]
    byStyle: StyleCounts
    notRemoved: number
  }
  notes: string[]
}

const SKIP_SENTENCES: Record<SkipReason, string> = {
  "not-ready": "had not finished processing",
  cancelled: "was not reached before the export was stopped",
  "verification-failed": "failed its export verification and was withheld",
  "rate-limited": "was not exported because the export allowance ran out",
  "archive-full": "did not fit in this archive",
  "export-failed": "could not be exported",
  container:
    "is a mailbox, so its messages were exported in its place rather than the mailbox itself",
  failed: "could not be processed",
  "empty-container":
    "is a mailbox none of whose messages could be included, so it was not rebuilt",
}

/** The same sentences, for the report's own list of left-out messages. */
export function skipSentence(reason: SkipReason): string {
  return SKIP_SENTENCES[reason]
}

/** Which check failed, as a clause. `message` is "message 4" or "a message". */
const FAILURE_SENTENCES: Record<
  MailboxRebuildFailure,
  (message: string) => string
> = {
  "artifact-mismatch": (message) =>
    `${message} no longer matched the export that passed verification`,
  "count-mismatch": () =>
    "it did not split back into the messages that went in",
  "message-mismatch": (message) =>
    `${message} read back out of it was not the message that went in`,
  "separator-leak": (message) =>
    `the separator line before ${message} carried an accepted value, or text Anonify does not write`,
}

function failureClause(failure: ContainerSummary["failure"]): string {
  if (!failure) return ""
  const message =
    failure.message === null ? "a message" : `message ${failure.message}`
  return `: ${FAILURE_SENTENCES[failure.check](message)}`
}

/**
 * `897 of 900 messages; 3 left out: message 4 (had not finished processing), …`
 *
 * By number, because the number is the message's name here — its folder in
 * the processed layout, its row in the batch — and its subject is document
 * content.
 */
export function containerNote(summary: ContainerSummary): string {
  const { total, included, leftOut } = summary.messages
  const count = `${included} of ${total} ${total === 1 ? "message" : "messages"}`

  const head = !summary.verified
    ? `A mailbox was rebuilt from ${count} and failed its verification, so it was withheld${failureClause(summary.failure)}.`
    : summary.checksum === null
      ? `A mailbox had none of its ${total} ${total === 1 ? "message" : "messages"} to include, so it was not rebuilt.`
      : `A mailbox was rebuilt with ${count}.`

  if (leftOut.length === 0 || summary.checksum === null) return head

  const named = leftOut
    .map(
      (entry) => `message ${entry.message} (${SKIP_SENTENCES[entry.reason]})`
    )
    .join(", ")
  return `${head} ${leftOut.length} left out: ${named}.`
}

export function buildBatchReport(input: {
  batchId: string
  reports: ExportReport[]
  skipped: { documentId: string; reason: SkipReason }[]
  /** Document ids whose vault is in the archive. */
  vaulted?: Set<string>
  output?: BatchOutput
  /** Where each included document went, keyed by document id. */
  placements?: Map<string, ContainerPlacement>
  containers?: ContainerSummary[]
  generatedAt?: Date
}): BatchReport {
  const containers = input.containers ?? []
  const byCategory = new Map<string, number>()
  const byStyle: StyleCounts = {}
  let removed = 0
  let notRemoved = 0

  for (const report of input.reports) {
    removed += report.removed.total
    notRemoved +=
      report.notRemoved.rejected.total + report.notRemoved.undecided.total

    for (const entry of report.removed.byCategory) {
      byCategory.set(
        entry.category,
        (byCategory.get(entry.category) ?? 0) + entry.count
      )
    }
    for (const [style, count] of Object.entries(report.removed.byStyle)) {
      const key = style as RemovalStyle
      byStyle[key] = (byStyle[key] ?? 0) + (count ?? 0)
    }
  }

  const notes = [
    "Counts only. Neither this report nor the per-document reports contain the redacted values.",
    "Each document was verified against its own exported bytes. A document that failed verification is listed as skipped rather than included.",
  ]

  const reversible = input.reports.filter(
    (report) => report.removed.byMethod.tokenize || report.removed.byMethod.encrypt
  ).length
  if (reversible > 0) {
    notes.push(
      `${reversible} ${reversible === 1 ? "document is" : "documents are"} reversible by whoever holds the vault beside ${reversible === 1 ? "it" : "them"} in this archive. Separate the vaults from the files before sharing either.`
    )
  }

  const pseudonymized = input.reports.filter(
    (report) => report.removed.byMethod.pseudonymize
  ).length
  if (pseudonymized > 0) {
    notes.push(
      `${pseudonymized} ${pseudonymized === 1 ? "document keeps" : "documents keep"} stable surrogates in place of values. Nothing reverses those, but a surrogate consistent across a file still preserves the equality somebody could re-identify by.`
    )
  }

  for (const skip of input.skipped) {
    notes.push(`One document ${SKIP_SENTENCES[skip.reason]}.`)
  }

  for (const summary of containers) notes.push(containerNote(summary))

  if (containers.some((summary) => summary.checksum !== null)) {
    notes.push(
      "A rebuilt mailbox is its messages' verified exports in their original order. Its separator lines were written by Anonify from each redacted message and name no sender; none of them was copied from the uploaded mailbox."
    )
  }

  return {
    version: REPORT_VERSION,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    batchId: input.batchId,
    output: input.output ?? "processed",
    // Named by id and checksum rather than by filename, for the reason given in
    // lib/redaction/report.ts: a file is regularly named after the person it is
    // about. The per-document report inside the archive carries the same id.
    documents: input.reports.map((report) => ({
      documentId: report.document.id,
      sourceChecksum: report.document.sourceChecksum,
      artifactChecksum: report.artifact.checksum,
      container: input.placements?.get(report.document.id) ?? null,
      removed: report.removed.total,
      methods: report.removed.byMethod,
      vault: input.vaulted?.has(report.document.id) ?? false,
    })),
    skipped: input.skipped,
    containers,
    totals: {
      documentsIncluded: input.reports.length,
      removed,
      byCategory: [...byCategory]
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category)),
      byStyle,
      notRemoved,
    },
    notes,
  }
}

export function serializeBatchReport(report: BatchReport): Uint8Array {
  return new Uint8Array(
    Buffer.from(`${JSON.stringify(report, null, 2)}\n`, "utf8")
  )
}

/**
 * `contract.pdf` → `contract`, safe to use as a path segment.
 *
 * Everything in a download that is named after an upload is named from this,
 * so a file, its folder, its report and its vault agree.
 */
export function baseName(originalName: string): string {
  return safeName(originalName.replace(/\.[^.]+$/, "") || "document")
}

/** `contract.pdf` → `contract-redacted.pdf`, keeping the name recognisable. */
export function artifactName(
  originalName: string,
  extension: string
): string {
  return `${baseName(originalName)}-redacted.${extension}`
}

export function reportName(originalName: string): string {
  return `${baseName(originalName)}-redaction-report.json`
}

/**
 * The vault that opens one file in the archive.
 *
 * Named after the file rather than after the batch, because it opens that file
 * and no other — a reviewer holding a zip of twelve documents needs to be able
 * to tell at a glance which vault belongs to which, and a single
 * `batch-vault.json` would suggest one key for the lot.
 */
export function vaultName(originalName: string): string {
  return `${baseName(originalName)}-vault.json`
}

/**
 * Zip entry names are paths. A file called `../../etc/passwd.pdf` is a name a
 * user can choose, and some extractors will happily honour it.
 */
function safeName(value: string): string {
  return (
    value
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/^\.+/, "")
      .slice(0, 80)
      .trim() || "document"
  )
}
