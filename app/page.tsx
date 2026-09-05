import Link from "next/link"
import { ShieldCheck } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Footer } from "@/components/layout/footer"
import { UploadPanel } from "@/components/upload/upload-panel"
import { FORMAT_LIST } from "@/lib/documents/formats"

const BENEFITS = [
  {
    title: "AI-assisted",
    body: "Detectors and a language model propose what looks sensitive — they never write the file.",
  },
  {
    title: "Human reviewed",
    body: "Every suggestion carries a category and a confidence. You accept or reject each one.",
  },
  {
    title: "Permanently redacted",
    body: "Export removes the content itself. No black rectangles sitting on top of live text.",
  },
]

export default function Page() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-16 items-center justify-between border-b border-border px-6 lg:h-20 lg:px-10">
        <Brand />
        <nav className="flex items-center gap-5">
          <Link
            href="/documents"
            className="text-xs text-text-secondary transition-colors hover:text-white"
          >
            Your documents
          </Link>
          <Link
            href="/about"
            className="text-xs text-text-secondary transition-colors hover:text-white"
          >
            About
          </Link>
          <span className="hidden items-center gap-2 text-xs text-text-muted sm:flex">
            <ShieldCheck className="size-4 text-primary" />
            Temporary by default
          </span>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-14 px-6 py-12 lg:px-10 lg:py-20">
        <section className="grid gap-10 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-16">
          <div className="flex flex-col gap-6">
            <p className="label-micro">AI-powered redaction</p>
            <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-white sm:text-5xl lg:text-6xl">
              Redact sensitive data
              <span className="block text-primary">without the drama</span>
            </h1>
            <p className="max-w-lg text-base leading-relaxed text-text-secondary">
              Drop a document. Anonify extracts its structure, proposes the
              sensitive parts, and lets you review every one before it writes a
              new file. The original is never modified.
            </p>
            <ul className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs tracking-[0.14em] text-text-muted uppercase">
              {FORMAT_LIST.map((format, index) => (
                <span key={format.kind} className="flex items-center gap-3">
                  {index > 0 ? (
                    <li aria-hidden className="text-text-muted/50">
                      ·
                    </li>
                  ) : null}
                  <li className="flex items-center gap-1.5">
                    {format.label}
                  </li>
                </span>
              ))}
            </ul>
          </div>

          <UploadPanel />
        </section>

        <section className="grid gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-3">
          {BENEFITS.map((benefit) => (
            <div key={benefit.title} className="bg-card p-6">
              <h2 className="text-sm font-semibold text-white">{benefit.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-text-muted">
                {benefit.body}
              </p>
            </div>
          ))}
        </section>

        <section className="flex flex-col gap-3 rounded-[10px] border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-relaxed text-text-muted">
            Want to know how it works? Every export is re-opened and read
            adversarially — a surviving value fails the export. That and the rest
            of the heavy lifting is in the About page.
          </p>
          <Link
            href="/about"
            className="btn-pill inline-flex h-9 shrink-0 items-center text-sm"
          >
            How it works
          </Link>
        </section>
      </main>

      <Footer />
    </div>
  )
}
