import type { Readable } from "node:stream"

import { prisma } from "@/lib/database/prisma"
import {
  buildVerifiedMailbox,
  MailboxRebuildError,
  searchedValues,
  streamRebuiltMailbox,
  type RebuildMessage,
} from "@/lib/documents/mbox/rebuild"
import { formatOf } from "@/lib/documents/formats"
import {
  buildBatchReport,
  containerNote,
  type BatchReport,
  type ContainerPlacement,
  type ContainerSummary,
  type SkipReason,
  type StreamedArchiveFile,
  serializeBatchReport,
} from "@/lib/redaction/archive"
import {
  artifactPath,
  mailboxLabelWidth,
  mailboxVaultPath,
  messageIndex,
  originalEntries,
  processedPlacements,
  provenancePath,
  provenanceTree,
  reportPath,
  rootOf,
  vaultPath,
  walk,
  type BatchOutput,
  type LayoutNode,
  type OriginalEntry,
} from "@/lib/redaction/batch-layout"
import { acceptedValues, fromDatabaseRow } from "@/lib/redaction/model"
import type { ExportReport } from "@/lib/redaction/report"
import { AccessError } from "@/lib/security/access-control"
import { artifactKey, reportKey, vaultKey } from "@/lib/storage/blob"
import {
  ChecksumMismatchError,
  checksumMatches,
  ChecksumVerifier,
  digestOf,
  sha256,
} from "@/lib/storage/integrity"
import {
  documentSeal,
  getSealed,
  getSealedStream,
  type DocumentSeal,
} from "@/lib/storage/sealed"
import { chain } from "@/lib/storage/streams"
import type { DocumentKind } from "@/types/document"

/**
 * Putting a batch back into the shape it was uploaded in.
 *
 * Nothing here redacts. Every file that leaves is an artifact the batch export
 * already produced and verified, re-hashed against the checksum it recorded —
 * exactly as the flat archive always was. What this adds is the choice of
 * shape, and one new artifact that is built rather than fetched: a mailbox,
 * rebuilt from its messages' exports and verified as its own export before a
 * byte of it is sent. See lib/documents/mbox/rebuild.ts.
 *
 * Two passes, as before. The first reads every artifact through a hash, keeps
 * nothing, and settles what goes in and what is named as left out — and, for a
 * mailbox, builds it once through the verifier. The second streams the files
 * that passed into the response, checked again on the way through. A file that
 * no longer matches then breaks the download off rather than completing it.
 */

/**
 * A ceiling on what one download carries. It was a memory limit when the
 * archive was assembled in memory; streamed, it is the bound on how much one
 * request is asked to read, decrypt and compress inside its time limit. What
 * does not fit is delivered as far as it fits and named as left out, rather
 * than timing out halfway through and delivering nothing usable. A file is
 * charged for every read after the one that hashes it: see `deliveredIn`.
 */
export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024

/** What the reviewer asked for: a shape, and optionally one upload. */
export type BatchDownloadRequest = {
  output: BatchOutput
  /**
   * One top-level upload rather than the whole batch — the mailbox a reviewer
   * is looking at in the workspace, downloaded as a mailbox.
   */
  documentId?: string | null
}

export type BatchDownload =
  /** One upload, in its own format, on its own: `inbox-redacted.mbox`. */
  | {
      kind: "file"
      filename: string
      mimeType: string
      open: () => Promise<Readable>
      report: BatchReport
    }
  | {
      kind: "archive"
      filename: string
      files: StreamedArchiveFile[]
      report: BatchReport
    }

export class NothingToDownloadError extends Error {
  constructor(
    /** What the download would have said, which `?part=report` still serves. */
    readonly report: BatchReport
  ) {
    super("This batch has nothing exported yet")
    this.name = "NothingToDownloadError"
  }
}

/**
 * Nothing to deliver, but not because nothing was exported: the only upload
 * asked for is a mailbox that failed its own verification or had nothing
 * that could go back into it.
 *
 * Its messages may every one be exported and verified, so "nothing exported
 * yet" would be false, and would send the reviewer to export again without
 * saying what went wrong. The message is the batch report's own note on the
 * mailbox, which does, and the report travels with it.
 */
export class MailboxWithheldError extends Error {
  constructor(
    readonly report: BatchReport,
    message: string
  ) {
    super(message)
    this.name = "MailboxWithheldError"
  }
}

const ARCHIVE_FILENAME = "anonify-batch-redacted.zip"

type BatchDocument = {
  id: string
  originalName: string
  kind: DocumentKind
  status: string
  parentDocumentId: string | null
  sourcePartPath: string | null
  encryptionKey: string | null
  encryptionFormat: string | null
}

/** One document's verified export, ready to be streamed again. */
type Collected = {
  extension: string
  mimeType: string
  checksum: string
  open: () => Promise<Readable>
  reportBytes: Uint8Array
  report: ExportReport
  vaultBytes: Uint8Array | null
}

function logMismatch(
  batchId: string,
  documentId: string,
  errorCategory: string
): void {
  console.error(
    JSON.stringify({
      level: "error",
      context: "batches.download",
      batchId,
      documentId,
      errorCategory,
    })
  )
}

/**
 * The most recent export of a document, re-hashed, or why there is none.
 *
 * The most recent, because that is what the export run that issued the token
 * has just produced. A document exported again in between contributes the
 * newer artifact — still current, still verified.
 */
async function collect(
  batchId: string,
  document: BatchDocument,
  budget: { used: number },
  weight: number
): Promise<Collected | SkipReason> {
  if (document.status === "expanded") return "container"
  if (document.status === "failed") return "failed"

  const artifact = await prisma.exportArtifact.findFirst({
    where: { documentId: document.id, reportBlobKey: { not: null } },
    orderBy: { createdAt: "desc" },
  })
  if (!artifact?.reportBlobKey || !document.encryptionKey) return "not-ready"

  const seal: DocumentSeal = documentSeal(document)
  const logicalKey = artifactKey(document.id, artifact.id, artifact.extension)
  const openRaw = () => getSealedStream(artifact.blobKey, logicalKey, seal)

  const [digest, reportBytes] = await Promise.all([
    openRaw().then((stream) => digestOf(stream)),
    getSealed(
      artifact.reportBlobKey,
      reportKey(document.id, artifact.id),
      seal
    ),
  ])

  if (
    !checksumMatches(artifact.checksum, digest.checksum) ||
    !checksumMatches(artifact.reportChecksum ?? "", sha256(reportBytes))
  ) {
    logMismatch(batchId, document.id, "checksum-mismatch")
    return "export-failed"
  }

  // Charged per read after this one: a file downloaded in both shapes is read
  // and compressed twice, and a message of a rebuilt mailbox is read once more
  // by the verifier before it is delivered.
  const cost = digest.size * weight
  if (budget.used + cost > MAX_DOWNLOAD_BYTES) return "archive-full"
  budget.used += cost

  // A vault whose checksum does not match is left out rather than shipped:
  // half a mapping restores half a document, and a reviewer would have no way
  // to tell which half. The file itself still goes in — it is verified
  // separately and is not made wrong by an unreadable vault — and the batch
  // report says which documents ended up with one.
  let vaultBytes: Uint8Array | null = null
  if (artifact.vaultBlobKey) {
    const bytes = await getSealed(
      artifact.vaultBlobKey,
      vaultKey(document.id, artifact.id),
      seal
    )
    if (checksumMatches(artifact.vaultChecksum ?? "", sha256(bytes))) {
      vaultBytes = bytes
    } else {
      logMismatch(batchId, document.id, "vault-checksum-mismatch")
    }
  }

  const expected = artifact.checksum
  return {
    extension: artifact.extension,
    mimeType: artifact.mimeType,
    checksum: expected,
    // Checked again as it streams: what passed a moment ago is what goes
    // out, or the download breaks off.
    open: async () =>
      chain(
        await openRaw(),
        new ChecksumVerifier(expected, () =>
          logMismatch(batchId, document.id, "checksum-mismatch")
        )
      ),
    reportBytes,
    report: JSON.parse(Buffer.from(reportBytes).toString("utf8")),
    vaultBytes,
  }
}

/**
 * How many times a shape has each node's artifact read after the pass that
 * hashes it — its weight against `MAX_DOWNLOAD_BYTES`. A node a shape does
 * not deliver has none, and is not read at all.
 */
export function deliveredIn(
  output: BatchOutput,
  entries: OriginalEntry[],
  nodes: LayoutNode[]
): Map<string, number> {
  const weight = new Map<string, number>()
  const add = (node: LayoutNode) =>
    weight.set(node.document.id, (weight.get(node.document.id) ?? 0) + 1)

  if (output !== "processed") {
    for (const entry of entries) {
      if (entry.kind === "file") {
        add(entry.node)
        continue
      }
      // Twice: once through the verifier that builds the mailbox, and once
      // more to deliver it. A plain file has only the delivery.
      for (const message of entry.messages) {
        add(message)
        add(message)
      }
    }
  }
  if (output !== "original") {
    for (const node of nodes) {
      if (formatOf(node.document.kind).exportable) add(node)
    }
  }

  return weight
}

/**
 * Every value the reviewer accepted anywhere in the batch, as the separator
 * check searches for them.
 *
 * The whole batch rather than the mailbox, because a separator line is text
 * this code writes and there is no value it has any business carrying.
 */
async function batchValues(documentIds: string[]): Promise<string[]> {
  const rows = await prisma.redaction.findMany({
    where: { documentId: { in: documentIds }, status: "accepted" },
  })
  return searchedValues(acceptedValues(rows.map(fromDatabaseRow)))
}

type Rebuilt =
  | { ok: true; open: () => Promise<Readable>; summary: ContainerSummary }
  | { ok: false; reason: SkipReason; summary: ContainerSummary }

/**
 * One mailbox, rebuilt from the messages that made it and verified.
 *
 * A message with no verified export is left out and named — never dropped in
 * silence, and never allowed to fail the rest. A mailbox that fails its own
 * verification is withheld whole: the check is about the file, and a file
 * that did not pass is not delivered in part.
 */
async function rebuildMailbox(input: {
  batchId: string
  entry: Extract<OriginalEntry, { kind: "mailbox" }>
  collected: Map<string, Collected>
  reasons: Map<string, SkipReason>
  values: () => Promise<string[]>
}): Promise<Rebuilt> {
  const { entry, collected, reasons } = input
  const included: RebuildMessage[] = []
  /** The message number of each included message, by position. */
  const numbers: number[] = []
  const leftOut: ContainerSummary["messages"]["leftOut"] = []

  for (const message of entry.messages) {
    const found = collected.get(message.document.id)
    const number = (messageIndex(message.document.sourcePartPath) ?? 0) + 1
    if (found) {
      included.push({ checksum: found.checksum, open: found.open })
      numbers.push(number)
    } else {
      leftOut.push({
        message: number,
        documentId: message.document.id,
        reason: reasons.get(message.document.id) ?? "not-ready",
      })
    }
  }

  const summary: ContainerSummary = {
    documentId: entry.node.document.id,
    kind: "mbox",
    checksum: null,
    verified: true,
    failure: null,
    messages: {
      total: entry.messages.length,
      included: included.length,
      leftOut,
    },
  }

  if (included.length === 0) {
    return { ok: false, reason: "empty-container", summary }
  }

  const values = await input.values()
  try {
    const verified = await buildVerifiedMailbox(included, values)
    summary.checksum = verified.checksum
    return {
      ok: true,
      summary,
      open: async () =>
        streamRebuiltMailbox(included, values, verified, () =>
          logMismatch(
            input.batchId,
            entry.node.document.id,
            "checksum-mismatch"
          )
        ),
    }
  } catch (error) {
    // A message whose stored bytes changed since the first pass hashed them
    // fails its own stream's check before the rebuild's; either way it is the
    // mailbox that did not verify, and it is withheld rather than a 500.
    if (
      !(error instanceof MailboxRebuildError) &&
      !(error instanceof ChecksumMismatchError)
    ) {
      throw error
    }
    const failure =
      error instanceof MailboxRebuildError ? error.failure : "artifact-mismatch"
    const index = error instanceof MailboxRebuildError ? error.index : null
    // The failure and the position, never the message: the log is not a
    // place for document content, and a position is enough to find it.
    console.error(
      JSON.stringify({
        level: "error",
        context: "batches.download",
        batchId: input.batchId,
        documentId: entry.node.document.id,
        errorCategory: "mailbox-verification-failed",
        failure,
        messageIndex: index,
      })
    )
    summary.verified = false
    // The same, for the reviewer: which check, and which message by the
    // number they know it by.
    summary.failure = {
      check: failure,
      message: index === null ? null : (numbers[index] ?? null),
    }
    return { ok: false, reason: "verification-failed", summary }
  }
}

/**
 * A mailbox that was not delivered, and not merely because its messages have
 * not been exported yet: withheld by its own verification, or with messages
 * left out for another reason — a stored export that no longer matched, one
 * too large for the download, one that could not be processed.
 */
function withheldMailbox(summary: ContainerSummary): boolean {
  return (
    summary.checksum === null &&
    (!summary.verified ||
      summary.messages.leftOut.some((entry) => entry.reason !== "not-ready"))
  )
}

/**
 * The download, planned and verified, ready to stream.
 *
 * Throws `MailboxWithheldError` when no file made it because a mailbox was
 * withheld, `NothingToDownloadError` when no file made it otherwise — both
 * carrying the report — and an `AccessError` for a `documentId` that is not a
 * top-level upload in this batch.
 */
export async function assembleBatchDownload(
  batchId: string,
  request: BatchDownloadRequest
): Promise<BatchDownload> {
  const { output } = request
  const documents = (await prisma.document.findMany({
    where: { batchId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      originalName: true,
      kind: true,
      status: true,
      parentDocumentId: true,
      sourcePartPath: true,
      encryptionKey: true,
      encryptionFormat: true,
    },
  })) as BatchDocument[]

  const byId = new Map(documents.map((document) => [document.id, document]))

  let roots = provenanceTree(documents)
  if (request.documentId) {
    roots = roots.filter((root) => root.document.id === request.documentId)
    if (roots.length === 0) {
      throw new AccessError("That document is not an upload in this batch", 404)
    }
  }

  const nodes = walk(roots)
  const entries = originalEntries(roots)
  const placements = processedPlacements(roots)
  const weights = deliveredIn(output, entries, nodes)

  // The first pass: every artifact that could go in, re-hashed, in the order
  // the reviewer uploaded things, so the budget runs out at the end of the
  // batch rather than somewhere arbitrary in the middle.
  const collected = new Map<string, Collected>()
  const reasons = new Map<string, SkipReason>()
  const budget = { used: 0 }

  for (const node of nodes) {
    const weight = weights.get(node.document.id)
    const document = byId.get(node.document.id) as BatchDocument
    if (!weight) {
      if (document.status === "expanded" && output === "processed") {
        reasons.set(document.id, "container")
      }
      continue
    }
    const result = await collect(batchId, document, budget, weight)
    if (typeof result === "string") reasons.set(document.id, result)
    else collected.set(document.id, result)
  }

  let values: Promise<string[]> | null = null
  const lazyValues = () =>
    (values ??= batchValues(documents.map((document) => document.id)))

  const files: StreamedArchiveFile[] = []
  const reports: ExportReport[] = []
  const reported = new Set<string>()
  const vaulted = new Set<string>()
  const containers: ContainerSummary[] = []
  /** Top-level outputs, for deciding whether one bare file will do. */
  const originals: {
    filename: string
    mimeType: string
    open: () => Promise<Readable>
    vaults: number
  }[] = []

  const includeReport = (node: LayoutNode, found: Collected) => {
    if (reported.has(node.document.id)) return
    reported.add(node.document.id)
    reports.push(found.report)
    const placement = placements.get(node.document.id)
    if (placement) {
      files.push({ name: reportPath(placement), bytes: found.reportBytes })
    }
  }

  const prefix =
    output === "both"
      ? { original: "original/", processed: "processed/" }
      : { original: "", processed: "" }

  if (output !== "processed") {
    for (const entry of entries) {
      const document = entry.node.document

      if (entry.kind === "file") {
        const found = collected.get(document.id)
        if (!found) continue
        const filename = `${entry.stem}-redacted.${found.extension}`
        files.push({ name: `${prefix.original}${filename}`, open: found.open })
        includeReport(entry.node, found)
        if (found.vaultBytes) {
          files.push({
            name: `${prefix.original}${entry.stem}-vault.json`,
            bytes: found.vaultBytes,
          })
          vaulted.add(document.id)
        }
        originals.push({
          filename,
          mimeType: found.mimeType,
          open: found.open,
          vaults: found.vaultBytes ? 1 : 0,
        })
        continue
      }

      const rebuilt = await rebuildMailbox({
        batchId,
        entry,
        collected,
        reasons,
        values: lazyValues,
      })
      containers.push(rebuilt.summary)
      if (!rebuilt.ok) {
        reasons.set(document.id, rebuilt.reason)
        continue
      }

      const filename = `${entry.stem}-redacted.mbox`
      files.push({ name: `${prefix.original}${filename}`, open: rebuilt.open })

      // One vault per message, beside the mailbox and never inside it. A
      // message's vault already opens its own attachments too.
      const width = mailboxLabelWidth(entry.node)
      let vaults = 0
      for (const message of entry.messages) {
        const found = collected.get(message.document.id)
        if (!found) continue
        includeReport(message, found)
        if (found.vaultBytes) {
          files.push({
            name: `${prefix.original}${mailboxVaultPath(entry.stem, message, width)}`,
            bytes: found.vaultBytes,
          })
          vaulted.add(message.document.id)
          vaults += 1
        }
      }

      originals.push({
        filename,
        mimeType: formatOf("mbox").mimeType,
        open: rebuilt.open,
        vaults,
      })
    }
  }

  if (output !== "original") {
    for (const node of nodes) {
      const found = collected.get(node.document.id)
      const placement = placements.get(node.document.id)
      if (!found || !placement) continue

      files.push({
        name: `${prefix.processed}${artifactPath(placement, found.extension)}`,
        open: found.open,
      })
      includeReport(node, found)
      if (found.vaultBytes) {
        files.push({
          name: `${prefix.processed}${vaultPath(placement)}`,
          bytes: found.vaultBytes,
        })
        vaulted.add(node.document.id)
      }
    }
  }

  // Named rather than left out: every document this download was about and
  // does not deliver, once each.
  const delivered = new Set(reported)
  const skipped = [...reasons]
    .filter(([documentId]) => !delivered.has(documentId))
    .map(([documentId, reason]) => ({ documentId, reason }))

  const containerOf = new Map<string, ContainerPlacement>()
  for (const node of nodes) {
    if (!node.parent) continue
    containerOf.set(node.document.id, {
      documentId: rootOf(node).document.id,
      path: provenancePath(node),
    })
  }

  const report = buildBatchReport({
    batchId,
    reports,
    skipped,
    vaulted,
    output,
    placements: containerOf,
    containers,
  })

  if (files.length === 0) {
    const withheld = containers.filter(withheldMailbox)
    if (withheld.length > 0) {
      throw new MailboxWithheldError(
        report,
        withheld.map(containerNote).join(" ")
      )
    }
    throw new NothingToDownloadError(report)
  }

  // One upload, in its own format, with nothing that has to travel beside
  // it: the file itself, not a zip of one file. A vault has to travel beside
  // it, so a reversible export still comes as an archive — the vault next to
  // the file, never inside it, and the report saying so.
  if (
    output === "original" &&
    entries.length === 1 &&
    originals.length === 1 &&
    originals[0].vaults === 0
  ) {
    const [only] = originals
    return {
      kind: "file",
      filename: only.filename,
      mimeType: only.mimeType,
      open: only.open,
      report,
    }
  }

  files.push({ name: "batch-report.json", bytes: serializeBatchReport(report) })

  return {
    kind: "archive",
    filename:
      request.documentId && entries.length === 1
        ? `${entries[0].stem}-redacted.zip`
        : ARCHIVE_FILENAME,
    files,
    report,
  }
}
