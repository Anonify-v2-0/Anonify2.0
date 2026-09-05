import Link from "next/link"
import { FileSpreadsheet, FileText, Image as ImageIcon, ShieldCheck } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Footer } from "@/components/layout/footer"
import { UploadPanel } from "@/components/upload/upload-panel"

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
              <li className="flex items-center gap-1.5">
                <FileText className="size-3.5 text-primary" /> PDF
              </li>
              <li aria-hidden>·</li>
              <li className="flex items-center gap-1.5">
                <FileText className="size-3.5 text-primary" /> DOCX
              </li>
              <li aria-hidden>·</li>
              <li className="flex items-center gap-1.5">
                <FileSpreadsheet className="size-3.5 text-primary" /> XLSX
              </li>
              <li aria-hidden>·</li>
              <li className="flex items-center gap-1.5">
                <ImageIcon className="size-3.5 text-primary" /> Image
              </li>
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
      </main>

      <Footer />
    </div>
  )
}
