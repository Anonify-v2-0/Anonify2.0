import type { Metadata } from "next"
import Link from "next/link"
import { FileText, ShieldCheck, Eye, Layers, Scale, FileCheck2, Gauge, Workflow, Lock } from "lucide-react"

import { Brand } from "@/components/layout/brand"
import { Footer } from "@/components/layout/footer"
import { KIND_ICONS } from "@/components/documents/kind-icon"
import { FORMAT_LIST } from "@/lib/documents/formats"
import { REPOSITORY_URL } from "@/lib/config"

export const metadata: Metadata = {
  title: "About — Anonify",
  description:
    "What Anonify is, the problems it is built to solve, and the mechanisms behind each guarantee it makes.",
}

/**
 * The page the landing page links to. The landing is the pitch; this is the
 * argument — each capability stated as a mechanism with the source file that
 * implements it, never as a compliance claim it cannot back.
 *
 * The format list is rendered from the same register the upload pipeline and
 * the export dispatch read (`lib/documents/formats.ts`), so it cannot drift
 * from what the tool actually accepts.
 */
const CAPABILITIES = [
  {
    icon: ShieldCheck,
    title: "Verification as a gate",
    body: "Every export is re-opened and read the way an adversary would — extracted PDF text, every OOXML part, every sheet including hidden ones — and refused if an accepted value survived.",
    source: "lib/redaction/validation.ts · tests/security.test.ts",
  },
  {
    icon: FileText,
    title: "Per-format fidelity",
    body: "DOCX edited in place byte-identically. XLSX cells rewritten, with formula results referencing redacted cells dropped. PPTX notes, layouts and master swept. EML MIME-tree surgery. PDF pages rasterized only where redacted. RTF parsed, not searched.",
    source: "lib/redaction/apply.ts · docs/pipelines.md",
  },
  {
    icon: Eye,
    title: "Human review is the whole model",
    body: "Detection produces suggestions. Only an accepted suggestion reaches the exporter — nothing is removed that a person did not accept. A wrong suggestion is a non-event, not a data loss.",
    source: "lib/redaction/model.ts",
  },
  {
    icon: Gauge,
    title: "Cost-disciplined detection",
    body: "Deterministic detectors first — Luhn-checked cards, structurally valid SSNs, IBANs, credentials. The model is asked only the contextual question, once per chunk. A value found once is expanded to every occurrence by local search.",
    source: "lib/ai/analyze.ts · lib/redaction/detectors.ts",
  },
  {
    icon: Layers,
    title: "Batch review with carried decisions",
    body: "Several files become one batch. A decision made once is carried to the others, including files that finish processing after it was made. Each document keeps its own run, failure and expiry.",
    source: "lib/redaction/rules.ts · lib/documents/batches.ts",
  },
  {
    icon: Scale,
    title: "Presets that cannot lie",
    body: "Named for what they search for, never for what they achieve. A preset whose id, label or description contains a regulation's name or a compliance claim fails validation at import.",
    source: "lib/redaction/presets.ts",
  },
  {
    icon: FileCheck2,
    title: "The export report",
    body: "Every export produces a second artifact: what was removed, by category and count, how each removal was applied, both checksums. It carries counts and never content — verified before it is stored.",
    source: "lib/redaction/report.ts",
  },
  {
    icon: Workflow,
    title: "Durable, resumable pipeline",
    body: "Retryable steps, resumable streams, survives serverless recycling. A timeout costs a retry, not the upload. Each document keeps its own run, quota and failure.",
    source: "lib/workflows/process-document.ts",
  },
  {
    icon: Lock,
    title: "Security by construction",
    body: "Per-document AES-256-GCM keys. TTL and scheduled purge of every artifact. Signed, short-lived, ownership-checked downloads. Logs carry ids and stages, never content, prompts or keys.",
    source: "lib/security/ · lib/storage/encryption.ts",
  },
]

export default function AboutPage() {
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
            href="/"
            className="text-xs text-text-secondary transition-colors hover:text-white"
          >
            Home
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-12 lg:px-10 lg:py-20">
        <section className="flex flex-col gap-5">
          <p className="label-micro">About</p>
          <h1 className="text-4xl leading-[1.05] font-bold tracking-tight text-white sm:text-5xl">
            A redaction tool that proves it worked
          </h1>
          <p className="max-w-2xl text-base leading-relaxed text-text-secondary">
            Anonify is an AI-assisted document redaction tool you clone and run
            yourself. It proposes what looks sensitive; you decide; the export
            removes it — and then re-opens the result to prove the value is
            actually gone. The original file is never modified.
          </p>
          <p className="max-w-2xl text-base leading-relaxed text-text-secondary">
            The governing rule: <span className="text-white">AI proposes, the
            application applies, and only what a person accepted is
            removed.</span> A redaction tool that leaves the original text under a
            black rectangle is not a redaction tool.
          </p>
        </section>

        <section className="mt-14">
          <h2 className="text-xs font-medium tracking-[0.14em] text-text-muted uppercase">
            What it can redact
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            Rendered from the same register the upload and export pipelines read,
            so it cannot drift from what the tool actually accepts.
          </p>
          <ul className="mt-5 flex flex-wrap gap-2">
            {FORMAT_LIST.map((format) => {
              const Icon = KIND_ICONS[format.kind]
              return (
                <li
                  key={format.kind}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-text-secondary"
                >
                  <Icon aria-hidden className="size-3.5 text-primary" />
                  {format.label}
                </li>
              )
            })}
          </ul>
        </section>

        <section className="mt-14">
          <h2 className="text-xs font-medium tracking-[0.14em] text-text-muted uppercase">
            The mechanisms
          </h2>
          <p className="mt-2 text-sm text-text-muted">
            Each capability is a real mechanism in the code, not a claim. The
            source file is where it lives.
          </p>
          <div className="mt-6 grid gap-px overflow-hidden rounded-[10px] border border-border bg-border sm:grid-cols-2">
            {CAPABILITIES.map((capability) => (
              <div key={capability.title} className="bg-card p-6">
                <div className="flex items-center gap-2.5">
                  <capability.icon className="size-4 text-primary" />
                  <h3 className="text-sm font-semibold text-white">
                    {capability.title}
                  </h3>
                </div>
                <p className="mt-2.5 text-sm leading-relaxed text-text-muted">
                  {capability.body}
                </p>
                <p className="mt-3 font-mono text-[11px] text-text-muted/70">
                  {capability.source}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="mt-14 flex flex-col gap-4 rounded-[10px] border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-white">
              Open source — clone and run it
            </h2>
            <p className="mt-1 text-sm text-text-muted">
              No accounts, no telemetry that leaves your machine, no vendor
              lock-in. The repo is where the heavy lifting lives.
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <a
              href={REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="btn-pill inline-flex h-9 items-center text-sm"
            >
              View source
            </a>
          </div>
        </section>

        <section className="mt-10">
          <h2 className="text-xs font-medium tracking-[0.14em] text-text-muted uppercase">
            Read further
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-text-muted">
            The full documentation — architecture, the workflow pipeline, the AI
            engine, per-format pipelines, presets, the data model, security
            internals — is in the{" "}
            <a
              href={`${REPOSITORY_URL}/tree/main/docs`}
              target="_blank"
              rel="noreferrer"
              className="text-text-secondary underline-offset-4 transition-colors hover:text-white hover:underline"
            >
              docs directory
            </a>{" "}
            and in{" "}
            <a
              href={`${REPOSITORY_URL}/blob/main/CONTRIBUTING.md`}
              target="_blank"
              rel="noreferrer"
              className="text-text-secondary underline-offset-4 transition-colors hover:text-white hover:underline"
            >
              CONTRIBUTING.md
            </a>
            .
          </p>
        </section>
      </main>

      <Footer />
    </div>
  )
}
