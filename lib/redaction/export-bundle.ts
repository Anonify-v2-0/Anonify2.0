import { zip, type Zippable } from "fflate"

/**
 * Every output of a multi-copy export, as one zip.
 *
 * Built in the browser from the same signed links the individual buttons use,
 * so the server serves each file through the one route that re-checks
 * ownership and re-hashes the bytes, and nothing new is stored or authorised
 * to make the bundle.
 *
 * The vault is deliberately not in it. It holds the original values and, for
 * an encrypted copy, the key, and the dialog tells the reviewer to keep it the
 * way they keep the source document. A zip that packed it next to the copy it
 * reverses would make the convenient thing and the unsafe thing the same.
 */

export type BundledArtifact = {
  variant: string
  downloadUrl: string
  reportUrl: string
}

type Fetcher = (url: string) => Promise<Response>

/**
 * `letter-redacted.pdf` → `letter-redacted-tokenized.pdf`.
 *
 * Every copy downloads under the same name, because the name comes from the
 * document, so the variant is what keeps two entries in one zip apart.
 */
export function withVariant(filename: string, variant: string): string {
  const dot = filename.lastIndexOf(".")
  return dot <= 0
    ? `${filename}-${variant}`
    : `${filename.slice(0, dot)}-${variant}${filename.slice(dot)}`
}

/** The name the server gave a download, from its `content-disposition`. */
export function filenameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("content-disposition") ?? ""
  const match = /filename="?([^";]+)"?/i.exec(header)
  return match?.[1]?.trim() || fallback
}

/**
 * The zip's entries: each copy and its report, named by variant.
 *
 * A copy that cannot be fetched fails the whole bundle rather than producing
 * a zip that silently holds one of two. A missing report is different: an
 * artifact exported before reports existed has none, and the server says so
 * with a 404.
 */
export async function collectBundle(
  artifacts: BundledArtifact[],
  fetcher: Fetcher = (url) => fetch(url, { cache: "no-store" })
): Promise<Zippable> {
  const entries: Zippable = {}

  for (const artifact of artifacts) {
    const file = await fetcher(artifact.downloadUrl)
    if (!file.ok) {
      throw new Error(`The ${artifact.variant} copy could not be downloaded`)
    }
    const name = withVariant(filenameFrom(file, "document"), artifact.variant)
    entries[unique(entries, name)] = new Uint8Array(await file.arrayBuffer())

    const report = await fetcher(artifact.reportUrl)
    if (report.ok) {
      const reportName = withVariant(
        filenameFrom(report, "redaction-report.json"),
        artifact.variant
      )
      entries[unique(entries, reportName)] = new Uint8Array(
        await report.arrayBuffer()
      )
    } else if (report.status !== 404) {
      throw new Error(`The ${artifact.variant} report could not be downloaded`)
    }
  }

  return entries
}

/** Zips off the main thread, so a large export does not freeze the dialog. */
export function zipBundle(entries: Zippable): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Level 6, as the batch archive uses: the documents are mostly compressed
    // already, and the reports are small.
    zip(entries, { level: 6 }, (error, data) =>
      error ? reject(error) : resolve(data)
    )
  })
}

/** Two variants with the same name are suffixed, not overwritten. */
function unique(entries: Zippable, name: string): string {
  if (!(name in entries)) return name
  for (let counter = 2; ; counter++) {
    const candidate = withVariant(name, String(counter))
    if (!(candidate in entries)) return candidate
  }
}
