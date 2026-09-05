"use client"

import { useEffect } from "react"
import { Code, RotateCcw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Brand } from "@/components/layout/brand"
import { REPOSITORY_URL } from "@/lib/config"

/**
 * Top-level error boundary. It says what is safe to assume — the uploaded file
 * was not modified — because that is the user's first question when a redaction
 * tool fails.
 */
export default function GlobalError({
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
        context: "app.boundary",
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
        <p className="label-micro text-primary">Something went wrong</p>
        <h1 className="text-2xl font-semibold text-white">
          This page could not be displayed
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          Your document was not modified. Nothing has been exported.
        </p>
        <Button className="btn-pill mt-2 h-10" onClick={reset}>
          <RotateCcw className="size-4" />
          Try again
        </Button>
        <a
          href={`${REPOSITORY_URL}/issues`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-white"
        >
          <Code className="size-3.5" />
          Think this is a bug? Open an issue
        </a>
      </main>
    </div>
  )
}
