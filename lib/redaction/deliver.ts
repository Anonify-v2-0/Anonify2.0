import { prisma } from "@/lib/database/prisma"
import { randomId } from "@/lib/documents/ids"
import { loadNormalized } from "@/lib/documents/normalized-store"
import type { ExportOptions } from "@/lib/redaction/apply"
import {
  resolveAttachments,
  type AttachmentOutcome,
} from "@/lib/redaction/attachments"
import { exportRedacted, ExportVerificationError } from "@/lib/redaction/export"
import { fromDatabaseRow } from "@/lib/redaction/model"
import { presetById } from "@/lib/redaction/presets"
import {
  assertReportOmitsValues,
  buildExportReport,
  ReportLeakError,
  serializeExportReport,
  type ExportReport,
} from "@/lib/redaction/report"
import { newValueKey, buildVault, type TokenVault } from "@/lib/redaction/vault"
import type { ExportVariant } from "@/lib/redaction/variants"
import { getObject, processedKey, putObject, reportKey } from "@/lib/storage/blob"
import { decryptDocument, encryptWithDocumentKey } from "@/lib/storage/encryption"
import { sha256 } from "@/lib/storage/integrity"
import type { DocumentKind } from "@/types/document"

/**
 * Generating an export and storing it.
 *
 * One document's worth of the whole thing: build it from the accepted
 * redactions, let the exporter verify it against the artifact it just produced,
 * write the report, seal both and record them. It lives here rather than in the
 * route because a batch export is this, several times — and a second copy of
 * these steps is a second place for the verification gate to be forgotten.
 *
 * A review can ask for more than one output. Each variant is a full pass —
 * its own plan, its own artifact, its own verification and its own report —
 * rather than one export post-processed into several, because the only way to
 * know an artifact is clean is to re-open that artifact and look. Sharing work
 * between variants would mean verifying one file and delivering another.
 *
 * A message is the one document that is not on its own. Exporting one exports
 * every attachment it was expanded into first, through this same function and
 * therefore the same gate, and substitutes the results back into the message
 * — so an enclosure is redacted by exactly the code that redacts it when it is
 * downloaded alone. Fresh each time rather than reusing the child's last
 * artifact, because a decision taken since then has to reach the copy inside
 * the message; the recursion is bounded by the expansion depth limit.
 */

export type DeliveredArtifact = {
  artifactId: string
  /** Where the sealed artifact actually landed, as storage named it. */
  blobKey: string
  /** Which output of the review this is; see lib/redaction/variants.ts. */
  variant: string
  checksum: string
  size: number
  bytes: Uint8Array
  extension: string
  mimeType: string
  appliedRedactions: number
  verifiedValues: number
  report: ExportReport
  /**
   * What the reviewer needs to reverse this variant, or null when nothing in
   * it is reversible.
   *
   * Returned and never stored. It holds original values and the key that
   * recovers them, so writing it beside the export would undo the export for
   * anyone who could read the bucket — and would make Anonify a party to a
   * recovery it has no business being able to perform.
   */
  vault: TokenVault | null
}

export type DeliveredExport = {
  artifacts: DeliveredArtifact[]
  /** The first variant asked for: what a caller saying "the export" means. */
  primary: DeliveredArtifact
  /** What became of each attachment, for a message. Empty for everything else. */
  attachments: AttachmentOutcome[]
}

export type ExportOutcome =
  | { ok: true; delivered: DeliveredExport }
  /** No normalized model or no sealed source: there is nothing to export yet. */
  | { ok: false; reason: "not-ready" }

export async function exportAndStore(
  documentId: string,
  variants: ExportVariant[],
  /**
   * The key `encrypt` uses, when this export has to share one with another.
   * Only a message passes it: its attachments are exported separately and
   * downloaded together, so one key has to open all of them.
   */
  sharedKey?: Buffer
): Promise<ExportOutcome> {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      id: true,
      kind: true,
      mimeType: true,
      size: true,
      pageCount: true,
      checksum: true,
      preset: true,
      encryptionKey: true,
      sourceBlobKey: true,
      normalizedBlobKey: true,
    },
  })

  if (
    !document?.sourceBlobKey ||
    !document.encryptionKey ||
    !document.normalizedBlobKey
  ) {
    return { ok: false, reason: "not-ready" }
  }

  const [model, rows] = await Promise.all([
    loadNormalized(document.normalizedBlobKey, document.encryptionKey),
    // Every redaction, not only the accepted ones: the exporter filters for
    // itself, and the report has to be able to say what was turned down.
    prisma.redaction.findMany({ where: { documentId: document.id } }),
  ])

  const redactions = rows.map(fromDatabaseRow)
  const sealed = await getObject(document.sourceBlobKey)
  const source = decryptDocument(sealed, document.encryptionKey)
  const kind = document.kind as DocumentKind
  const preset = presetById(document.preset)

  const artifacts: DeliveredArtifact[] = []
  let attachments: AttachmentOutcome[] = []

  for (const variant of variants) {
    // One key per variant, made before the attachments are exported so the
    // message and everything inside it encrypt under the same one. Unused
    // keys are never reported: `Surrogates.key` stays null until something is
    // actually encrypted.
    const options: ExportOptions = {
      addLabels: variant.addLabels,
      sanitizeMetadata: variant.sanitizeMetadata,
      imageStyle: variant.imageStyle,
      methods: variant.methods,
      valueKey: sharedKey ?? newValueKey(),
    }

    const resolved = await resolveAttachments({
      documentId: document.id,
      kind,
      source,
      exportChild: (childId) =>
        exportChild(childId, variant, options.valueKey as Buffer),
    })

    // Reported from the last variant rather than accumulated: every variant
    // resolves the same attachments the same way, and the dispositions are a
    // fact about the message rather than about how it was redacted.
    attachments = resolved.outcomes

    const result = await exportRedacted({
      kind,
      source,
      model,
      redactions,
      options,
      mimeType: document.mimeType,
      attachments: resolved.substitutions,
    })

    const artifactId = randomId("exp", 16)
    const stored = await putObject(
      processedKey(document.id, `${artifactId}.${result.extension}`),
      encryptWithDocumentKey(result.bytes, document.encryptionKey)
    )

    const report = buildExportReport({
      document: {
        id: document.id,
        kind,
        sizeBytes: document.size,
        pageCount: document.pageCount,
        sourceChecksum: document.checksum ?? "",
      },
      artifact: {
        checksum: result.checksum,
        sizeBytes: result.bytes.byteLength,
        mimeType: result.mimeType,
        extension: result.extension,
      },
      options,
      variant: variant.name,
      surrogates: result.surrogates,
      redactions,
      verification: {
        passed: result.verification.passed,
        checkedValues: result.verification.checkedValues,
      },
      preset,
      attachments: resolved.outcomes,
    })

    // The report is verified the way the export is, and for the same reason: it
    // is about to be handed to someone who was not shown the original.
    assertReportOmitsValues(
      report,
      redactions.filter((redaction) => redaction.status === "accepted")
    )

    const reportBytes = serializeExportReport(report)
    const storedReport = await putObject(
      reportKey(document.id, artifactId),
      encryptWithDocumentKey(reportBytes, document.encryptionKey)
    )

    await prisma.exportArtifact.create({
      data: {
        id: artifactId,
        documentId: document.id,
        variant: variant.name,
        blobKey: stored.key,
        checksum: result.checksum,
        mimeType: result.mimeType,
        extension: result.extension,
        size: result.bytes.byteLength,
        appliedRedactions: result.appliedRedactions,
        metadataSanitized: options.sanitizeMetadata,
        labelsAdded: options.addLabels,
        reportBlobKey: storedReport.key,
        reportChecksum: sha256(reportBytes),
      },
    })

    const vaultEntries = [
      ...result.surrogates.vaultEntries,
      ...resolved.vaultEntries,
    ]
    // The key is reported if this document encrypted anything *or* one of its
    // enclosures did — they share it, and the reviewer gets one download.
    const key =
      result.surrogates.key ??
      (resolved.vaultKeyUsed ? (options.valueKey as Buffer) : null)

    artifacts.push({
      artifactId,
      blobKey: stored.key,
      variant: variant.name,
      checksum: result.checksum,
      size: result.bytes.byteLength,
      bytes: result.bytes,
      extension: result.extension,
      mimeType: result.mimeType,
      appliedRedactions: result.appliedRedactions,
      verifiedValues: result.verification.checkedValues,
      report,
      vault:
        vaultEntries.length > 0 || key
          ? buildVault({
              documentId: document.id,
              artifactChecksum: result.checksum,
              key,
              entries: vaultEntries,
            })
          : null,
    })
  }

  const primary = artifacts[0]

  // The document's own pointer names the first variant. A second variant is a
  // second artifact with its own row and its own link; overwriting the pointer
  // with each in turn would leave it naming whichever finished last.
  //
  // The key comes back from storage rather than being rebuilt from the id: a
  // driver is entitled to store the object under a name of its own, and
  // reconstructing the path here would point the document at a key that does
  // not exist.
  await prisma.document.update({
    where: { id: document.id },
    data: {
      processedBlobKey: primary.blobKey,
      processedChecksum: primary.checksum,
    },
  })

  return { ok: true, delivered: { artifacts, primary, attachments } }
}

/**
 * One attachment's own export, or null when there is nothing to substitute.
 *
 * A verification failure is caught here rather than allowed to fail the
 * message, and it takes the same road as a verification failure inside a batch
 * does: the document is withheld and named. The difference from a batch is
 * where the naming lands — the attachment is *removed* from the message and
 * the export report says why, so the reviewer is never handed a message that
 * looks complete because one enclosure quietly stayed as it was.
 *
 * The child is exported under one variant — the message's — because it is
 * going inside one message. Its own artifacts are stored and its own vault
 * entries come back to be merged into the message's, so the reviewer holds one
 * vault that opens the whole download.
 */
async function exportChild(
  childDocumentId: string,
  variant: ExportVariant,
  valueKey: Buffer
): Promise<{
  bytes: Uint8Array
  checksum: string
  vaultEntries: TokenVault["entries"]
  vaultKeyUsed: boolean
} | null> {
  try {
    const outcome = await exportAndStore(childDocumentId, [variant], valueKey)
    if (!outcome.ok) return null

    const { primary } = outcome.delivered
    return {
      bytes: primary.bytes,
      checksum: primary.checksum,
      vaultEntries: primary.vault?.entries ?? [],
      vaultKeyUsed: Boolean(primary.vault?.key),
    }
  } catch (error) {
    if (
      error instanceof ExportVerificationError ||
      error instanceof ReportLeakError
    ) {
      console.error(
        JSON.stringify({
          level: "error",
          context: "exports.attachment",
          documentId: childDocumentId,
          errorCategory: "verification-failed",
        })
      )
      return null
    }
    throw error
  }
}

