"use client"

import Image from "next/image"
import Link from "next/link"
import { Loader2, RotateCcw, TriangleAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useRetryDocument } from "@/hooks/use-retry-document"
import { isRetryable } from "@/lib/workflows/failure"
import { cn } from "@/lib/utils"
import type { DocumentSummary } from "@/types/document"

/**
 * What a failed document says for itself.
 *
 * Two shapes, one set of rules, because the alternative was two sets that
 * disagreed. The full screen is for a document that failed before there was
 * anything to review; the banner sits above the editor when extraction got far
 * enough that manual redaction is still worth offering.
 *
 * Retry is shown only when retrying could actually change the outcome. An
 * unsupported file type does not become supported on the second attempt, and a
 * button that spends a rate-limit token to reach the same conclusion is worse
 * than no button — so those cases get the action that does help instead.
 */
export function FailureNotice({
  summary,
  variant,
  onRetried,
}: {
  summary: DocumentSummary
  variant: "screen" | "banner"
  onRetried: () => void
}) {
  const { retry, retryingId } = useRetryDocument()
  const retrying = retryingId === summary.id
  const retryable = isRetryable(summary.errorCode)

  const reason =
    summary.error?.trim() ||
    "Something went wrong while analyzing this document."

  async function onRetry() {
    if (await retry(summary.id)) onRetried()
  }

  const action = retryable ? (
    <Button
      className={cn(variant === "screen" && "btn-pill mt-2 h-10")}
      size={variant === "banner" ? "sm" : undefined}
      variant={variant === "banner" ? "outline" : undefined}
      disabled={retrying}
      onClick={onRetry}
    >
      {retrying ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RotateCcw className="size-4" />
      )}
      {retrying ? "Starting…" : "Retry analysis"}
    </Button>
  ) : (
    <Link
      href="/"
      className={cn(
        "inline-flex items-center rounded-full border border-border text-sm text-text-secondary transition-colors hover:text-white",
        variant === "screen" ? "mt-2 h-10 px-5" : "h-8 shrink-0 px-4"
      )}
    >
      Upload a different file
    </Link>
  )

  if (variant === "banner") {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 border-b border-red-border bg-surface-2 px-4 py-2.5 text-xs sm:px-6"
      >
        <TriangleAlert className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-text-secondary">
          <span className="font-medium text-white">Analysis did not finish.</span>{" "}
          {reason}{" "}
          <span className="text-text-muted">
            You can still redact this document by hand; there may be no
            suggestions to review.
          </span>
        </p>
        {action}
      </div>
    )
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
      <Image
        src="/Anonify.png"
        alt=""
        width={48}
        height={48}
        className="rounded-[10px] opacity-60 grayscale"
      />
      <p className="label-micro text-primary">Processing failed</p>
      <h1 className="text-2xl font-semibold text-white">
        We couldn&apos;t analyze this document
      </h1>
      <p className="max-w-md text-sm text-text-muted">
        Your original file is safe and was not modified.
      </p>
      <p className="max-w-md rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text-secondary">
        {reason}
      </p>
      {action}
    </main>
  )
}
