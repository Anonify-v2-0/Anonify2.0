import { createRequire } from "node:module"
import path from "node:path"
import { pathToFileURL } from "node:url"

/**
 * Shared pdf.js loading for the server.
 *
 * Font and CMap data live inside the installed package, so the paths are
 * resolved from the package itself rather than assumed relative to the working
 * directory — the bundle layout on a serverless deployment is not the repo's.
 */

const require = createRequire(import.meta.url)

function pdfjsAsset(...segments: string[]): string {
  const root = path.dirname(require.resolve("pdfjs-dist/package.json"))
  return path.join(root, ...segments)
}

function assetUrl(...segments: string[]): string {
  return `${pathToFileURL(pdfjsAsset(...segments)).href}/`
}

export type PdfjsRuntime = Awaited<
  typeof import("pdfjs-dist/legacy/build/pdf.mjs")
> & {
  standardFontDataUrl: string
  cMapUrl: string
}

/**
 * pdf.js transfers (and thereby detaches) the buffer it is handed, so every
 * caller passes its own copy — otherwise extracting a document would make the
 * same bytes unreadable for the exporter that runs next.
 */
export function copyBytes(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes)
}

export async function loadPdfjsForRender(): Promise<PdfjsRuntime> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs")

  // Node has no DOM worker, so pdf.js runs its worker module in-process. It
  // still needs to know where that module lives.
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    pdfjsAsset("legacy", "build", "pdf.worker.mjs")
  ).href

  // The module namespace object is frozen, so the asset paths travel alongside
  // it rather than being attached to it.
  return {
    ...pdfjs,
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
  } as PdfjsRuntime
}
