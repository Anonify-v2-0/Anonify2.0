/**
 * End-to-end smoke test against a running Anonify.
 *
 *   pnpm smoke                          # http://127.0.0.1:3000
 *   pnpm smoke http://localhost:8080
 *
 * Upload, process, accept, export, download — then read the downloaded bytes
 * and fail if an accepted value is still in them. It talks to the HTTP API the
 * browser talks to, and asserts on the artifact rather than on the pipeline's
 * own account of itself.
 *
 * This exists because a container can pass every unit test and still not run:
 * file tracing drops a native library, a workflow world resolves to nothing, a
 * bucket was never created. None of that is visible until something asks the
 * assembled system to actually redact a document. CI runs this against
 * `docker compose up`; run it yourself against anything you have deployed.
 *
 * The document is synthetic and built here — no real personal data, in this
 * repository or in your storage.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

/**
 * The fixture is built here rather than imported from `tests/` on purpose: the
 * container image excludes the test tree, and a script the image cannot compile
 * fails the build rather than the smoke test. Same shape as
 * `makePdfFixture` — a page with a name, an email and a phone number.
 */
const SENSITIVE = {
  person: "John Smith",
  email: "john@example.com",
  phone: "+1 (415) 555-0132",
} as const

async function makePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])

  const lines = [
    `${SENSITIVE.person} works at Example Corporation.`,
    `Email: ${SENSITIVE.email}`,
    `Phone: ${SENSITIVE.phone}`,
  ]

  let y = 720
  for (const text of lines) {
    page.drawText(text, { x: 72, y, size: 12, font, color: rgb(0, 0, 0) })
    y -= 24
  }

  return pdf.save()
}

const BASE = (
  process.argv[2] ??
  process.env.ANONIFY_URL ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "")

/** How long the pipeline gets before we call it hung. */
const READY_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000

/**
 * fetch has no cookie jar, and the session cookie *is* the identity here —
 * every ownership check downstream reads it. Carrying it by hand keeps this
 * dependency-free and makes the identity model visible rather than incidental.
 */
const cookies = new Map<string, string>()

function remember(response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";")
    const index = pair.indexOf("=")
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1))
  }
}

function cookieHeader(): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
}

async function call(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookies.size > 0) headers.set("cookie", cookieHeader())

  const response = await fetch(`${BASE}${path}`, { ...init, headers })
  remember(response)
  return response
}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response
  const body = await response.text().catch(() => "")
  throw new Error(
    `${what} failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`
  )
}

async function json<T>(response: Response, what: string): Promise<T> {
  return (await (await expectOk(response, what)).json()) as T
}

const steps: string[] = []

function step(message: string): void {
  steps.push(message)
  console.log(`  ${message}`)
}

async function main(): Promise<void> {
  console.log(`smoke: ${BASE}\n`)

  // 1. The app is serving. A standalone build with a missing static chunk or a
  //    world that failed to load falls over right here.
  await expectOk(await call("/"), "GET /")
  step("app responds")

  // 2. Reserve. Writes a row, charges the quota, and tells the client which
  //    upload path this install is configured for.
  const bytes = await makePdf()
  const filename = `smoke-${Date.now()}.pdf`

  const reserved = await json<{
    id: string
    pathname: string
    uploadMode: string
  }>(
    await call("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename,
        size: bytes.byteLength,
        contentType: "application/pdf",
        ttlSeconds: 3600,
      }),
    }),
    "reserve"
  )
  step(`reserved ${reserved.id} (upload mode: ${reserved.uploadMode})`)

  // 3. Upload. On a self-hosted install this goes through the app to S3/MinIO
  //    or the local filesystem; on Vercel the browser would upload to Blob
  //    directly and this script would have nothing to do here.
  if (reserved.uploadMode === "vercel-blob") {
    throw new Error(
      "This install is configured for direct Vercel Blob uploads, which the " +
        "browser performs with a scoped token. Point the smoke test at a " +
        "self-hosted instance instead."
    )
  }

  const form = new FormData()
  form.set("documentId", reserved.id)
  form.set("file", new File([new Uint8Array(bytes)], filename, { type: "application/pdf" }))

  const uploaded = await json<{ url: string; size: number }>(
    await call("/api/upload/local", { method: "POST", body: form }),
    "upload"
  )
  step(`uploaded ${uploaded.size} bytes to ${uploaded.url}`)

  // 4. Hand it to the durable pipeline. Everything after this runs in the
  //    workflow: ingest, extraction, normalization, detection.
  await json<{ runId: string }>(
    await call(`/api/documents/${reserved.id}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blobUrl: uploaded.url }),
    }),
    "process"
  )
  step("workflow started")

  const deadline = Date.now() + READY_TIMEOUT_MS
  let summary: { status: string; pageCount: number | null; error?: string | null }

  for (;;) {
    summary = await json(
      await call(`/api/documents/${reserved.id}`),
      "document status"
    )
    if (summary.status === "ready") break
    if (summary.status === "failed") {
      throw new Error(`processing failed: ${summary.error ?? "no reason given"}`)
    }
    if (Date.now() > deadline) {
      throw new Error(
        `still ${summary.status} after ${READY_TIMEOUT_MS / 1000}s — ` +
          "the workflow worker is probably not running"
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  step(`ready, ${summary.pageCount} page(s)`)

  // 5. Suggestions. Without an AI key only the deterministic detectors run,
  //    which is exactly the configuration CI uses — the fixture's email and
  //    phone number are found by pattern alone, so this assertion holds with
  //    or without a model.
  const { redactions } = await json<{
    redactions: { id: string; text?: string; status: string }[]
  }>(await call(`/api/documents/${reserved.id}/redactions`), "list redactions")

  if (redactions.length === 0) {
    throw new Error("no suggestions were produced for a document that has PII")
  }
  step(`${redactions.length} suggestion(s)`)

  // 6. Accept. This is the only step that makes any of it count.
  const ids = redactions.map((redaction) => redaction.id)
  await json<{ updated: number }>(
    await call(`/api/documents/${reserved.id}/redactions`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, status: "accepted" }),
    }),
    "accept"
  )
  step(`accepted ${ids.length}`)

  const exported = await json<{
    size: number
    appliedRedactions: number
    verifiedValues: number
    downloadUrl: string
  }>(
    await call(`/api/documents/${reserved.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addLabels: false, sanitizeMetadata: true }),
    }),
    "export"
  )
  step(
    `exported ${exported.size} bytes, ${exported.appliedRedactions} applied, ` +
      `${exported.verifiedValues} verified`
  )

  // 7. Read the artifact back and look for the values ourselves. The export
  //    already refuses to deliver a file that fails its own verification;
  //    this is the independent check, which is the only kind worth having.
  const download = await expectOk(await call(exported.downloadUrl), "download")
  const artifact = Buffer.from(await download.arrayBuffer())
  const haystack = `${artifact.toString("latin1")}\n${artifact.toString("utf8")}`

  const accepted = redactions
    .map((redaction) => redaction.text)
    .filter((text): text is string => Boolean(text && text.trim().length > 2))

  const survivors = [...new Set(accepted)].filter((value) =>
    haystack.includes(value)
  )
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} accepted value(s) survived the export: ${survivors
        .map((value) => JSON.stringify(value))
        .join(", ")}`
    )
  }

  // The fixture's values, checked by name as well, so a change to what the
  // detectors return cannot quietly turn the assertion above into a no-op.
  const known = [SENSITIVE.email, SENSITIVE.phone].filter((value) =>
    haystack.includes(value)
  )
  if (known.length > 0) {
    throw new Error(`fixture value(s) still present: ${known.join(", ")}`)
  }
  step(`downloaded ${artifact.byteLength} bytes, no accepted value present`)

  // 8. Clean up after ourselves, and exercise deletion while we are here.
  await expectOk(
    await call(`/api/documents/${reserved.id}`, { method: "DELETE" }),
    "delete"
  )
  step("deleted")

  console.log(`\nsmoke passed (${steps.length} steps)`)
}

main().catch((error: unknown) => {
  console.error(`\nsmoke FAILED after ${steps.length} step(s)`)
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
