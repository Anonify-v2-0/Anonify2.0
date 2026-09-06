import Image from "next/image"
import Link from "next/link"
import { Mails } from "lucide-react"

import type { DocumentSummary } from "@/types/document"

/**
 * What a mailbox says for itself once it has been expanded.
 *
 * The one place in the product where opening a document shows you something
 * other than that document, and it has to say so plainly. A mailbox is not a
 * file that was redacted — it is the batch its messages arrived in, and there
 * is nothing here to review: no pages, no suggestions, no export. Left to the
 * ordinary processing screen it would sit on "Analyzing document" forever,
 * which is the exact failure this codebase treats as the worst kind, a
 * finished thing that reads as a stuck one.
 *
 * So it says what happened, how many messages came out, and points at the
 * batch where the review actually is.
 */
export function ExpandedNotice({ summary }: { summary: DocumentSummary }) {
  const batchId = summary.batch?.batchId ?? null
  // The container's own children, not the size of the batch: a mailbox
  // uploaded alongside three other files sits in a batch of more than it made.
  const messages = summary.expandedChildren ?? null

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <Image
        src="/Anonify.png"
        alt=""
        width={48}
        height={48}
        className="rounded-[10px]"
      />
      <p className="label-micro text-primary">Mailbox expanded</p>
      <h1 className="text-2xl font-semibold text-white">
        {messages === null
          ? "This mailbox became a batch"
          : `This mailbox became ${messages} document${messages === 1 ? "" : "s"}`}
      </h1>
      <p className="max-w-md text-sm text-text-muted">
        Every message in it is a document of its own, with its own analysis and
        its own export. Review them together in the batch — a decision you make
        in one message is carried to the rest, including the ones still being
        processed.
      </p>
      {batchId ? (
        <Link
          href={`/batches/${batchId}`}
          className="btn-pill mt-2 inline-flex h-10 items-center gap-2 px-5 text-sm"
        >
          <Mails className="size-4" />
          Open the batch
        </Link>
      ) : (
        <Link
          href="/documents"
          className="mt-2 inline-flex h-10 items-center rounded-full border border-border px-5 text-sm text-text-secondary transition-colors hover:text-white"
        >
          Back to documents
        </Link>
      )}
    </main>
  )
}
