"use client"

import Image from "next/image"
import { useRouter } from "next/navigation"
import { Check, Loader2 } from "lucide-react"

import { FailureNotice } from "@/components/processing/failure-notice"
import { documentStatusChanged } from "@/store/documentSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { cn } from "@/lib/utils"
import type { DocumentSummary } from "@/types/document"

/**
 * The stages a document actually passes through.
 *
 * There used to be a "Preparing editor" row bound to the `rendering` status,
 * which the workflow never emits — so it sat greyed out until the document went
 * ready and then completed without ever having been active. A step the pipeline
 * does not take should not be drawn as one it is about to.
 */
const STAGES: { key: string; label: string; statuses: string[] }[] = [
  { key: "upload", label: "Uploading", statuses: ["uploading"] },
  { key: "extract", label: "Extracting", statuses: ["queued", "extracting"] },
  { key: "structure", label: "Understanding structure", statuses: ["normalizing"] },
  { key: "detect", label: "Finding sensitive data", statuses: ["analyzing"] },
]

const ORDER = ["uploading", "queued", "extracting", "normalizing", "analyzing", "rendering", "ready"]

function stageState(stage: (typeof STAGES)[number], status: string) {
  if (status === "ready") return "done"
  const stageIndex = Math.min(
    ...stage.statuses.map((s) => ORDER.indexOf(s)).filter((i) => i >= 0)
  )
  const currentIndex = ORDER.indexOf(status)
  if (currentIndex > stageIndex) return "done"
  if (currentIndex === stageIndex) return "active"
  return "pending"
}

export function ProcessingScreen({ summary }: { summary: DocumentSummary }) {
  const dispatch = useAppDispatch()
  const router = useRouter()
  const suggestionCount = useAppSelector((state) => state.processing.suggestionCount)

  if (summary.status === "failed") {
    return (
      <FailureNotice
        summary={summary}
        variant="screen"
        // Moving the status locally is what reconnects the processing stream,
        // which only subscribes while a document is still working.
        onRetried={() => {
          dispatch(documentStatusChanged("queued"))
          router.refresh()
        }}
      />
    )
  }

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Image
          src="/Anonify.png"
          alt=""
          width={56}
          height={56}
          priority
          className="brand-float mb-6 rounded-[10px]"
        />
        <p className="label-micro mb-6 text-primary">Analyzing document</p>

        <ol className="space-y-3">
          {STAGES.map((stage) => {
            const state = stageState(stage, summary.status)
            return (
              <li
                key={stage.key}
                className={cn(
                  "flex items-center justify-between gap-4 text-sm transition-colors duration-200",
                  state === "active"
                    ? "text-white"
                    : state === "done"
                      ? "text-text-secondary"
                      : "text-text-muted/60"
                )}
              >
                <span className="tracking-wide uppercase">{stage.label}</span>
                {state === "done" ? (
                  <Check className="size-4 text-text-secondary" />
                ) : state === "active" ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <span className="size-1.5 rounded-full border border-border" />
                )}
              </li>
            )
          })}
        </ol>

        {suggestionCount > 0 ? (
          <p className="mt-8 text-sm text-text-secondary">
            <span className="font-semibold text-white">{suggestionCount}</span>{" "}
            potential sensitive items found
          </p>
        ) : null}
      </div>
    </main>
  )
}
