import Link from "next/link"
import { Code } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { REPOSITORY_URL } from "@/lib/config"

export default function NotFound() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center border-b border-border px-6">
        <Brand />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="label-micro">Not found</p>
        <h1 className="text-2xl font-semibold text-white">
          There is no document here
        </h1>
        <p className="max-w-md text-sm text-text-muted">
          It may have expired, or it may belong to a different session.
        </p>
        <Link href="/" className="btn-pill mt-2 inline-flex h-10 items-center">
          Upload a document
        </Link>
        <a
          href={`${REPOSITORY_URL}/issues`}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 text-xs text-text-muted transition-colors hover:text-white"
        >
          <Code className="size-3.5" />
          Something missing? Open an issue
        </a>
      </main>
    </div>
  )
}
