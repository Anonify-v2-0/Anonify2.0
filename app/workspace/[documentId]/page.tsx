import Link from "next/link"
import { notFound } from "next/navigation"

import { Workspace } from "@/components/editor/workspace"
import { Brand } from "@/components/layout/brand"
import { batchPositionFor } from "@/lib/documents/batches"
import { expandedChildCount } from "@/lib/documents/expand"
import { presetById, presetNarrows } from "@/lib/redaction/presets"
import { AccessError, requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import type { DocumentKind, DocumentSummary } from "@/types/document"

export const dynamic = "force-dynamic"

export default async function WorkspacePage(
  props: PageProps<"/workspace/[documentId]">
) {
  const { documentId } = await props.params

  let summary: DocumentSummary
  try {
    const identity = await peekIdentity()
    const document = await requireDocument(documentId, identity?.ownerKey)
    const preset = presetById(document.preset)
    summary = {
      id: document.id,
      originalName: document.originalName,
      kind: document.kind as DocumentKind,
      mimeType: document.mimeType,
      size: document.size,
      status: document.status,
      pageCount: document.pageCount,
      createdAt: document.createdAt.toISOString(),
      expiresAt: document.expiresAt.toISOString(),
      error: document.error,
      errorCode: document.errorCode,
      // Extraction is the line: past it there is a normalized model to open and
      // redact by hand, before it there is nothing an editor could show.
      reviewable: Boolean(document.normalizedBlobKey),
      batch: await batchPositionFor(document.id, document.batchId),
      // Only for a container, which is the only kind that has any. Everything
      // else would spend a query to be told zero.
      expandedChildren:
        document.status === "expanded"
          ? await expandedChildCount(document.id)
          : null,
      // Only when it narrowed something: "looked for everything" is noise.
      presetLabel: presetNarrows(preset) ? (preset?.label ?? null) : null,
    }
  } catch (error) {
    if (error instanceof AccessError && error.status === 410) {
      return <ExpiredNotice />
    }
    if (error instanceof AccessError) {
      notFound()
    }
    throw error
  }

  return <Workspace summary={summary} />
}

function ExpiredNotice() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center border-b border-border px-6">
        <Brand />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="label-micro">Document expired</p>
        <h1 className="text-2xl font-semibold text-white">
          This document is no longer available
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          Its retention window elapsed, so the source file, every generated
          artifact and its redaction record were deleted.
        </p>
        <Link href="/" className="btn-pill mt-2 inline-flex h-10 items-center">
          Upload a new document
        </Link>
      </main>
    </div>
  )
}
