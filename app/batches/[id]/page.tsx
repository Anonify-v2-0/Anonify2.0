import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeft, UploadCloud } from "lucide-react"

import { BatchView } from "@/components/batch/batch-view"
import { Brand } from "@/components/layout/brand"
import {
  batchOverview,
  requireBatch,
  type BatchOverview,
} from "@/lib/documents/batches"
import { AccessError } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"

export const dynamic = "force-dynamic"

export const metadata: Metadata = {
  title: "Batch — Anonify",
  description:
    "Documents uploaded together, the decisions carried across them, and one archive at the end.",
}

export default async function BatchPage(props: PageProps<"/batches/[id]">) {
  const { id } = await props.params

  // The fetch is what can fail; the JSX is deliberately outside the try, because
  // a render error thrown inside one is not caught by it and hiding a component
  // behind `catch (notFound)` would swallow bugs as "no such batch".
  let overview: BatchOverview
  try {
    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)
    overview = await batchOverview(batch)
  } catch (error) {
    if (error instanceof AccessError) notFound()
    throw error
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between gap-4 border-b border-border px-6 lg:h-20 lg:px-10">
        <div className="flex min-w-0 items-center gap-4">
          <Brand />
          {/* The way back out of a batch, so the two pages are a loop. */}
          <Link
            href="/documents"
            className="flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-white"
          >
            <ArrowLeft className="size-4" />
            <span className="hidden sm:inline">Documents</span>
          </Link>
        </div>
        <Link
          href="/"
          className="btn-pill inline-flex h-9 items-center gap-2 text-sm"
        >
          <UploadCloud className="size-4" />
          New upload
        </Link>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10 lg:px-10 lg:py-14">
        <div className="mb-8 flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="label-micro">Batch</p>
            <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Reviewed together
            </h1>
          </div>
          <p className="max-w-xs text-xs leading-relaxed text-text-muted">
            A decision made in one of these documents can be carried to the
            rest. Each still processes, fails and expires on its own.
          </p>
        </div>

        <BatchView initial={overview} />
      </main>
    </div>
  )
}
