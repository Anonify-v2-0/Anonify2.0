import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"

import { RARE_CATEGORIES } from "./spec"
import { CATEGORIES, type LabelledDocument, type Split } from "./types"

/**
 * manifest.json: what the corpus contains, and a hash of every file in it.
 * Benchmark results cite `corpus` — the hash of the file list — so a number
 * can always be traced to the exact documents it was measured on.
 */

export const TEST_TARGET = 400
export const RARE_TEST_TARGET = 250

type Counts = Record<string, number>

export type Manifest = {
  corpus: string
  documents: {
    total: number
    bySplit: Counts
    byLocale: Counts
    byDocType: Counts
    byLength: Counts
    byDensity: Counts
  }
  spans: { total: number; byCategory: Record<Split, Counts>; negatives: number }
  /** Per category, whether the test split has enough instances for #59. */
  targets: Record<string, { test: number; target: number; met: boolean }>
  generators: Counts
  reviewedByHuman: number
  files: Record<string, string>
}

function bump(counts: Counts, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by
}

function sorted(counts: Counts): Counts {
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))
  )
}

/** Every `<split>/<id>.json` under `root`, relative, in a stable order. */
export async function listDocumentFiles(root: string): Promise<string[]> {
  const files: string[] = []
  for (const split of ["dev", "test"]) {
    let names: string[] = []
    try {
      names = await readdir(path.join(root, split))
    } catch {
      continue
    }
    for (const name of names.sort()) {
      if (name.endsWith(".json")) files.push(`${split}/${name}`)
    }
  }
  return files
}

export async function buildManifest(root: string): Promise<Manifest> {
  const files: Record<string, string> = {}
  const bySplit: Counts = {}
  const byLocale: Counts = {}
  const byDocType: Counts = {}
  const byLength: Counts = {}
  const byDensity: Counts = {}
  const byCategory: Record<Split, Counts> = { dev: {}, test: {} }
  const generators: Counts = {}
  let spans = 0
  let negatives = 0
  let reviewed = 0

  const documentFiles = await listDocumentFiles(root)
  for (const file of documentFiles) {
    const bytes = await readFile(path.join(root, file))
    files[file] = createHash("sha256").update(bytes).digest("hex")
    const document = JSON.parse(bytes.toString("utf8")) as LabelledDocument
    bump(bySplit, document.split)
    bump(byLocale, document.locale)
    bump(byDocType, document.docType)
    bump(byLength, document.length)
    bump(byDensity, document.density)
    bump(
      generators,
      `${document.generator.backend}/${document.generator.model}@prompt-v${document.generator.promptVersion}`
    )
    if (document.generator.reviewedByHuman) reviewed++
    for (const span of document.spans)
      bump(byCategory[document.split], span.category)
    spans += document.spans.length
    negatives += document.negatives.length
  }

  const targets: Manifest["targets"] = {}
  for (const category of CATEGORIES) {
    const target = RARE_CATEGORIES.includes(category)
      ? RARE_TEST_TARGET
      : TEST_TARGET
    const test = byCategory.test[category] ?? 0
    targets[category] = { test, target, met: test >= target }
  }

  const listing = Object.entries(files)
    .map(([file, hash]) => `${hash}  ${file}\n`)
    .join("")

  return {
    corpus: `sha256:${createHash("sha256").update(listing).digest("hex")}`,
    documents: {
      total: documentFiles.length,
      bySplit: sorted(bySplit),
      byLocale: sorted(byLocale),
      byDocType: sorted(byDocType),
      byLength: sorted(byLength),
      byDensity: sorted(byDensity),
    },
    spans: {
      total: spans,
      byCategory: {
        dev: sorted(byCategory.dev),
        test: sorted(byCategory.test),
      },
      negatives,
    },
    targets,
    generators: sorted(generators),
    reviewedByHuman: reviewed,
    files,
  }
}
