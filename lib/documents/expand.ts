import type { Prisma } from "@/lib/database/generated/client"
import { prisma } from "@/lib/database/prisma"
import { decodeEml } from "@/lib/documents/eml/parse"
import {
  planExpansion,
  type AttachmentRefusal,
  type ExpansionLimits,
} from "@/lib/documents/eml/attachments"
import { isPureContainer } from "@/lib/documents/formats"
import { newBatchId, newDocumentId, newUsageId } from "@/lib/documents/ids"
import type { MboxLimits } from "@/lib/documents/mbox/limits"
import {
  messagePartPath,
  planMailbox,
  type MessageRefusal,
} from "@/lib/documents/mbox/messages"
import { checkQuota, quotaMessage } from "@/lib/security/usage"
import { getObject, putObject, sourceKey } from "@/lib/storage/blob"
import { decryptDocument, encryptDocument } from "@/lib/storage/encryption"
import { sha256 } from "@/lib/storage/integrity"
import { failureForCode } from "@/lib/workflows/failure"
import type { DocumentKind } from "@/types/document"

/**
 * Turning a container into a batch.
 *
 * A batch already means the right thing: several documents reviewed as one
 * pass, decisions carried across them, one archive at the end, each keeping
 * its own run and its own failure so one document failing leaves the others
 * alone. Two things in this pipeline are containers in exactly that sense, and
 * they are the same relationship at two scales:
 *
 *   - **a message with attachments.** The carried decisions are a genuine win
 *     rather than a convenience, because "this recurring name is a colleague,
 *     not a subject", answered in the covering letter, is the same answer in
 *     the enclosure.
 *   - **a mailbox.** Here they are the entire point. A decision taken on the
 *     first message reaching all nine hundred is work nobody would do by hand,
 *     and it is the reason this format is worth supporting at all.
 *
 * The difference between the two is only which planner enumerates the
 * children. Everything after that — the batch, the sealed bytes, the charge,
 * the idempotency, the refusals that are rows rather than silence — is one
 * piece of code, because a child that arrived out of a mailbox and a child
 * that arrived out of a message must be the same kind of thing.
 *
 * **This is not reservation.** `reserveDocument` runs before the browser has
 * uploaded anything: there are no bytes to parse and the declared MIME type is
 * a guess. The container is not knowable until ingest holds the real bytes,
 * which is why this is a step of its own between ingest and extraction.
 *
 * From here on nothing downstream can tell the difference. A child gets its own
 * workflow run, its own extraction, its own detectors, its own review and its
 * own export — that indistinguishability is what keeps this from becoming a
 * second, weaker pipeline.
 */

export type ExpandedChild = {
  id: string
  partPath: string
  kind: DocumentKind
  /** True when there is a run to start: a refused child is already settled. */
  processable: boolean
}

export type ExpansionSummary = {
  batchId: string | null
  children: ExpandedChild[]
  /** Parts in formats this cannot read, left exactly as they arrived. */
  carried: number
  /** True when the work happened on this call rather than on an earlier one. */
  expanded: boolean
  /**
   * True when the document is only a container — a mailbox — so there is
   * nothing left to extract, analyze or export once its children exist.
   */
  container: boolean
}

/** Why a child is a row and a sentence rather than a document. */
type ChildRefusal = AttachmentRefusal | MessageRefusal

/**
 * One child a container will produce, whichever container it came out of.
 *
 * The two planners disagree about almost everything — a MIME path against a
 * message index, a declared filename against a generated one — and agree about
 * this, which is the only shape the work below needs.
 */
type PlannedChild = {
  /** Unique and stable within the parent; the database enforces both. */
  partPath: string
  name: string
  kind: DocumentKind
  mimeType: string
  bytes: Uint8Array
  /** Null for a child that becomes a document. */
  refusal: ChildRefusal | null
  /** Recorded on the child so where it came from can be read back. */
  provenance: Record<string, unknown>
}

type ContainerPlan = {
  children: PlannedChild[]
  /** Parts left exactly as they arrived, which produce no child at all. */
  carried: number
}

/** What the parent's metadata records once expansion has run. */
type ExpansionMark = {
  at: string
  children: number
  carried: number
  depth: number
}

/** How deep in a chain of containers this document sits; zero if uploaded. */
export function expansionDepth(metadata: unknown): number {
  const record = asRecord(asRecord(metadata)?.expansion)
  const depth = record?.depth
  return typeof depth === "number" && Number.isFinite(depth) ? depth : 0
}

/**
 * Expands a container, once.
 *
 * Idempotent in two independent ways, because the step that calls it is
 * retried and re-parses the source from scratch each time:
 *
 *   - the parent carries a mark once the pass has finished, which is the fast
 *     path and the record that it happened at all;
 *   - and `(parentDocumentId, sourcePartPath)` is unique in the database, so a
 *     retry that died halfway through the previous attempt cannot produce a
 *     second copy of a part it already created.
 *
 * The second is what makes the charge idempotent. The upload count and the
 * child row are written in one transaction, so a part is charged exactly when
 * it becomes a document — a crash between the two leaves neither, and a retry
 * that finds the row skips both.
 */
export async function expandContainer(
  documentId: string,
  options: { limits?: ExpansionLimits; mboxLimits?: MboxLimits } = {}
): Promise<ExpansionSummary> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      batchId: true,
      preset: true,
      ttlSeconds: true,
      expiresAt: true,
      userFingerprint: true,
      quotaKey: true,
      sourceBlobKey: true,
      encryptionKey: true,
      checksum: true,
      metadata: true,
    },
  })

  if (!document) throw new Error("Document no longer exists")

  const kind = document.kind as DocumentKind
  const container = isPureContainer(kind)

  // Only a message and a mailbox hold other documents. Everything else takes
  // the cheap road out rather than the caller having to know which kinds
  // expand.
  if (kind !== "eml" && kind !== "mbox") {
    return {
      batchId: document.batchId,
      children: [],
      carried: 0,
      expanded: false,
      container,
    }
  }

  const existingMark = asRecord(
    asRecord(document.metadata)?.attachmentsExpanded
  )
  if (existingMark) {
    return {
      batchId: document.batchId,
      children: await recordedChildren(documentId),
      carried: Number(existingMark.carried ?? 0),
      expanded: false,
      container,
    }
  }

  if (!document.sourceBlobKey || !document.encryptionKey) {
    throw new Error("Document has not been ingested")
  }

  const sealed = await getObject(document.sourceBlobKey)
  const source = decodeEml(decryptDocument(sealed, document.encryptionKey))
  const depth = expansionDepth(document.metadata)

  const plan =
    kind === "mbox"
      ? planMailboxChildren(source, depth, options.mboxLimits)
      : planAttachmentChildren(source, depth, options.limits)

  if (plan.children.length === 0) {
    await mark(documentId, document.metadata, {
      at: new Date().toISOString(),
      children: 0,
      carried: plan.carried,
      depth,
    })
    return {
      batchId: document.batchId,
      children: [],
      carried: plan.carried,
      expanded: true,
      container,
    }
  }

  // A container is a batch, so one is created for a document that arrived on
  // its own. A document that arrived inside a batch keeps that one: the
  // reviewer's decisions already span it, and a second batch would stop them
  // reaching what came out of this.
  const batchId =
    document.batchId ??
    (await createBatch(documentId, document.userFingerprint))

  const children: ExpandedChild[] = []

  for (const planned of plan.children) {
    const child = await materialize({
      planned,
      parent: {
        id: documentId,
        batchId,
        preset: document.preset,
        ttlSeconds: document.ttlSeconds,
        expiresAt: document.expiresAt,
        userFingerprint: document.userFingerprint,
        quotaKey: document.quotaKey,
      },
      depth: depth + 1,
    })
    if (child) children.push(child)
  }

  await mark(documentId, document.metadata, {
    at: new Date().toISOString(),
    children: children.length,
    carried: plan.carried,
    depth,
  })

  return {
    batchId,
    children,
    carried: plan.carried,
    expanded: true,
    container,
  }
}

/**
 * The attachments of a message, in the shape the work below takes.
 *
 * A carried attachment — one in a format this pipeline cannot read — produces
 * no child at all, which is the one difference from a mailbox: every message
 * in a mailbox is a message, so there is nothing to carry.
 */
function planAttachmentChildren(
  source: string,
  depth: number,
  limits: ExpansionLimits | undefined
): ContainerPlan {
  const plan = planExpansion(source, { depth, limits })

  const children: PlannedChild[] = []

  for (const entry of plan.entries) {
    if (entry.action === "carry") continue
    children.push({
      partPath: entry.attachment.path,
      name: entry.name,
      kind: entry.kind,
      mimeType: entry.mimeType,
      bytes: entry.attachment.bytes,
      refusal: entry.action === "refuse" ? entry.reason : null,
      provenance: {
        partPath: entry.attachment.path,
        contentId: entry.attachment.contentId,
        inline: entry.attachment.inline,
      },
    })
  }

  return { children, carried: plan.entries.length - children.length }
}

/** The messages of a mailbox, in the same shape. */
function planMailboxChildren(
  source: string,
  depth: number,
  limits: MboxLimits | undefined
): ContainerPlan {
  const plan = planMailbox(source, { depth, limits })

  return {
    children: plan.entries.map((entry) => ({
      partPath: messagePartPath(entry.entry.index),
      name: entry.name,
      kind: entry.kind,
      mimeType: entry.mimeType,
      bytes: entry.entry.bytes,
      refusal: entry.action === "refuse" ? entry.reason : null,
      provenance: {
        // The position in the mailbox, which is what provenance means here.
        // The `From ` line is not recorded: it carries the envelope sender,
        // which is document content, and this column is not a place for it.
        messageIndex: entry.entry.index,
        messages: plan.entries.length,
      },
    })),
    // Every message in a mailbox is a message. Nothing is carried through,
    // because there is no third thing for one to be.
    carried: 0,
  }
}

/**
 * How many documents a container produced.
 *
 * Refusals included, because they are documents in the batch: a message the
 * allowance did not stretch to is a row the reviewer has to see, and counting
 * only the successes would tell them the mailbox was smaller than it was.
 */
export async function expandedChildCount(documentId: string): Promise<number> {
  return prisma.document.count({ where: { parentDocumentId: documentId } })
}

/** The children an earlier pass already created, for a replaying step. */
async function recordedChildren(
  parentDocumentId: string
): Promise<ExpandedChild[]> {
  const rows = await prisma.document.findMany({
    where: { parentDocumentId },
    select: { id: true, kind: true, sourcePartPath: true, status: true },
    orderBy: { createdAt: "asc" },
  })

  return rows.map((row) => ({
    id: row.id,
    partPath: row.sourcePartPath ?? "",
    kind: row.kind as DocumentKind,
    processable: row.status !== "failed",
  }))
}

async function createBatch(
  originDocumentId: string,
  userFingerprint: string
): Promise<string> {
  const batchId = newBatchId()

  await prisma.batch.create({ data: { id: batchId, userFingerprint } })
  await prisma.document.update({
    where: { id: originDocumentId },
    data: { batchId },
  })

  return batchId
}

type ParentContext = {
  id: string
  batchId: string
  preset: string | null
  ttlSeconds: number
  expiresAt: Date
  userFingerprint: string
  quotaKey: string | null
}

/**
 * One child, as a row and as sealed bytes.
 *
 * Returns null only when the part already has a child — a retry landing on
 * work a previous attempt finished. Everything else produces a document, even
 * the refusals: a part missing from the batch with no row for it is a reviewer
 * believing they have seen everything.
 */
async function materialize(input: {
  planned: PlannedChild
  parent: ParentContext
  depth: number
}): Promise<ExpandedChild | null> {
  const { planned, parent, depth } = input
  const partPath = planned.partPath

  const existing = await prisma.document.findUnique({
    where: {
      parentDocumentId_sourcePartPath: {
        parentDocumentId: parent.id,
        sourcePartPath: partPath,
      },
    },
    select: { id: true, kind: true, status: true, sourceBlobKey: true },
  })

  if (existing?.sourceBlobKey) {
    return {
      id: existing.id,
      partPath,
      kind: existing.kind as DocumentKind,
      processable: existing.status !== "failed",
    }
  }
  // A row without sealed bytes is a previous attempt that died between the two
  // writes. Removing it lets this pass redo both under the same claim rather
  // than leaving a document nothing can ever process.
  if (existing) await prisma.document.delete({ where: { id: existing.id } })

  const bytes = planned.bytes
  // A refusal decided from the bytes is free; only a document that will
  // actually be processed spends an upload. The allowance exists to bound
  // work, and a child that is a row and a sentence is not work.
  const refusal = planned.refusal ?? (await quotaRefusal(parent.quotaKey))

  const documentId = newDocumentId()
  const common = {
    id: documentId,
    originalName: planned.name,
    kind: planned.kind,
    mimeType: planned.mimeType,
    size: bytes.byteLength,
    preset: parent.preset,
    userFingerprint: parent.userFingerprint,
    quotaKey: parent.quotaKey,
    batchId: parent.batchId,
    parentDocumentId: parent.id,
    sourcePartPath: partPath,
    ttlSeconds: parent.ttlSeconds,
    // The same clock as the container it came out of. A child that outlived
    // its parent would be an orphan nobody can place; one that died first
    // would leave a container whose export cannot be rebuilt.
    expiresAt: parent.expiresAt,
    metadata: {
      expansion: {
        depth,
        parentDocumentId: parent.id,
        ...planned.provenance,
      },
    } as Prisma.InputJsonValue,
  }

  if (refusal) {
    const failure = failureForCode(refusal)
    await prisma.document.create({
      data: {
        ...common,
        status: "failed",
        error:
          refusal === "quota"
            ? await quotaSentence(parent.quotaKey)
            : failure.message,
        errorCode: refusal,
      },
    })
    return { id: documentId, partPath, kind: planned.kind, processable: false }
  }

  // The charge and the claim, together. Either the batch gained a document and
  // was billed one upload for it, or neither happened and the retry starts
  // this part over — which is what keeps a retried expansion from charging the
  // same message twice.
  await chargeAndClaim(parent.quotaKey, { ...common, status: "queued" })

  const { ciphertext, wrappedKey } = encryptDocument(bytes)
  const stored = await putObject(sourceKey(documentId), ciphertext)

  await prisma.document.update({
    where: { id: documentId },
    data: {
      sourceBlobKey: stored.key,
      encryptionKey: wrappedKey,
      checksum: sha256(bytes),
    },
  })

  return { id: documentId, partPath, kind: planned.kind, processable: true }
}

/**
 * Whether the upload allowance covers one more document.
 *
 * A child costs what the same file would cost uploaded on its own: one
 * `uploads` count here, plus its own per-kind allowance charged later, when its
 * extraction knows the real size, through the same `chargeDocumentUsage` path
 * everything else uses. A message is not a discount and neither is a mailbox,
 * for the same reason a batch is not one.
 *
 * The difference from an ordinary upload is that the `uploads` charge is a
 * pre-check at reservation, and here there is nothing to refuse in advance —
 * the bytes already exist. So a child the allowance does not cover is present,
 * named and explicitly skipped, carrying the reason the reviewer would have
 * been given at upload time.
 */
async function quotaRefusal(
  quotaKey: string | null
): Promise<ChildRefusal | null> {
  if (!quotaKey) return null
  const quota = await checkQuota(quotaKey, "uploads")
  return quota.allowed ? null : "quota"
}

async function quotaSentence(quotaKey: string | null): Promise<string> {
  if (!quotaKey) return failureForCode("quota").message
  return quotaMessage(await checkQuota(quotaKey, "uploads"))
}

/** Quota windows are calendar days in UTC, as everywhere else. */
function today(): Date {
  const now = new Date()
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
}

async function chargeAndClaim(
  quotaKey: string | null,
  data: Prisma.DocumentUncheckedCreateInput
): Promise<void> {
  if (!quotaKey) {
    await prisma.document.create({ data })
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.usageRecord.upsert({
      where: { fingerprint_date: { fingerprint: quotaKey, date: today() } },
      create: {
        id: newUsageId(),
        fingerprint: quotaKey,
        date: today(),
        uploads: 1,
      },
      update: { uploads: { increment: 1 } },
    })
    await tx.document.create({ data })
  })
}

async function mark(
  documentId: string,
  metadata: unknown,
  value: ExpansionMark
): Promise<void> {
  await prisma.document.update({
    where: { id: documentId },
    data: {
      metadata: {
        ...(asRecord(metadata) ?? {}),
        attachmentsExpanded: value,
      } as Prisma.InputJsonValue,
    },
  })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
