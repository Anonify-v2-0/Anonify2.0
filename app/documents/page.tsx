import type { Metadata } from "next"
import Link from "next/link"
import { UploadCloud } from "lucide-react"

import { DocumentList } from "@/components/documents/document-list"
import { AggregateUsageSummary } from "@/components/documents/usage-summary"
import { Brand } from "@/components/layout/brand"
import { aggregateUsage } from "@/lib/ai/usage-report"
import { listDocuments } from "@/lib/documents/listing"
import { peekIdentity } from "@/lib/security/fingerprint"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Your documents — Anonify",
  description:
    "Documents in this session, their review progress, and when each one expires.",
}

/**
 * The session's work.
 *
 * Anonify has no accounts, so "your documents" means the ones belonging to this
 * browser session. The list reads the database directly rather than going back
 * out through the API — it is a server component, and the identity it scopes by
 * is the same one every other read uses.
 */
export default async function DocumentsPage() {
  const identity = await peekIdentity()
  const [documents, usage] = await Promise.all([
    listDocuments(identity?.ownerKey),
    aggregateUsage(identity?.ownerKey),
  ])

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b border-border px-6 lg:h-20 lg:px-10">
        <Brand />
        <Link
          href="/"
          className="btn-pill inline-flex h-9 items-center gap-2 text-sm"
        >
          <UploadCloud className="size-4" />
          New document
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="label-micro">Your documents</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              {documents.length === 0
                ? "Nothing in progress"
                : documents.length === 1
                  ? "1 document in progress"
                  : `${documents.length} documents in progress`}
            </h1>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-text-muted">
            These belong to this browser session. Each one disappears when its
            retention window ends — the file, every artifact, and the record.
          </p>
        </div>

        <DocumentList initialDocuments={documents} />

        {usage.totals.calls > 0 ? (
          <div className="mt-8">
            <AggregateUsageSummary usage={usage} />
          </div>
        ) : null}
      </main>
    </div>
  )
}
