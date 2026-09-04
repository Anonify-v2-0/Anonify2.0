"use client"

import Image from "next/image"
import { Check, Loader2, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useAppSelector } from "@/store/hooks"
import { cn } from "@/lib/utils"
import type { DocumentSummary } from "@/types/document"

const STAGES: { key: string; label: string; statuses: string[] }[] = [
  { key: "upload", label: "Uploading", statuses: ["uploading"] },
  { key: "extract", label: "Extracting", statuses: ["queued", "extracting"] },
  { key: "structure", label: "Understanding structure", statuses: ["normalizing"] },
  { key: "detect", label: "Finding sensitive data", statuses: ["analyzing"] },
  { key: "prepare", label: "Preparing editor", statuses: ["rendering"] },
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
  const suggestionCount = useAppSelector((state) => state.processing.suggestionCount)
  const failed = summary.status === "failed"

  if (failed) {
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
          Your original file is safe and was not modified. You can retry the
          analysis, or redact manually.
        </p>
        <Button className="btn-pill mt-2 h-10">
          <RotateCcw className="size-4" />
          Retry analysis
        </Button>
      </main>
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
