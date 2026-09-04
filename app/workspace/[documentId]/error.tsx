"use client"

import { useEffect } from "react"
import Link from "next/link"
import { RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Brand } from "@/components/layout/brand"

/**
 * Workspace error boundary. A failure while reviewing must never imply that a
 * redaction was applied, so it says plainly what state the document is in.
 */
export default function WorkspaceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(
      JSON.stringify({
        level: "error",
        context: "workspace.boundary",
        digest: error.digest,
        errorCategory: "render",
      })
    )
  }, [error])

  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center border-b border-border px-6">
        <Brand />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="label-micro text-primary">Workspace error</p>
        <h1 className="text-2xl font-semibold text-white">
          The editor could not be loaded
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          Your source file and your accepted redactions are saved. Nothing was
          exported, and the original document is untouched.
        </p>
        <div className="mt-2 flex gap-2">
          <Button className="btn-pill h-10" onClick={reset}>
            <RotateCcw className="size-4" />
            Reload the workspace
          </Button>
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-full border border-border px-5 text-sm text-text-secondary transition-colors hover:text-white"
          >
            Start over
          </Link>
        </div>
      </main>
    </div>
  )
}
