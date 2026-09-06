import type { Metadata } from "next"
import Link from "next/link"
import { UploadCloud } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Footer } from "@/components/layout/footer"
import { RestoreForm } from "@/components/redaction/restore-form"

export const metadata: Metadata = {
  title: "Restore an export — Anonify",
  description:
    "Put the original values back into a tokenized or encrypted export, using the vault you downloaded with it.",
}

/**
 * The other end of tokenize and encrypt.
 *
 * A method is only worth offering if the reversal is a thing the tool does
 * rather than a thing the reviewer is left to build, so the reversal has a page
 * of its own rather than living in a paragraph of the docs.
 *
 * There is no document to select and no session to be in. The reviewer holds
 * both halves — the export and the vault — and that is deliberate: a version of
 * this that worked from stored state would be a version where Anonify could
 * reverse the redaction without them.
 */
export default function RestorePage() {
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

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10 lg:px-10 lg:py-14">
        <p className="label-micro">Restore</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Put the values back
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-text-secondary">
          A tokenized or encrypted export can be reversed with the vault that
          came with it. Anonify keeps no copy of that vault and no copy of the
          key inside it, so this page cannot reverse anything on its own — which
          is the point of handing them to you in the first place.
        </p>

        <div className="mt-8">
          <RestoreForm />
        </div>
      </main>

      <Footer />
    </div>
  )
}
