import { execFileSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"

import { syncBeforeRun } from "../corpus/lib/archive"
import { listDocumentFiles } from "../corpus/lib/manifest"
import type { LabelledDocument } from "../corpus/lib/types"

/**
 * Reading the corpus for a benchmark: the archive is brought up to date in the
 * working copy first, so a fresh clone or a pull needs no separate step.
 */

export type SplitName = "test" | "dev" | "all"

export function parseSplit(value: string): SplitName {
  if (value === "test" || value === "dev" || value === "all") return value
  throw new Error(
    `--split must be test, dev or all, not ${JSON.stringify(value)}`
  )
}

export async function loadCorpus(
  root: string,
  split: string
): Promise<LabelledDocument[]> {
  await syncBeforeRun(root)
  const files = (await listDocumentFiles(root)).filter(
    (file) => split === "all" || file.startsWith(`${split}/`)
  )
  if (files.length === 0) {
    throw new Error(
      `no ${split === "all" ? "" : `${split} `}documents in ${path.relative(process.cwd(), root)}; is ${path.basename(root)}.tar.gz there?`
    )
  }
  return Promise.all(
    files.map(
      async (file) =>
        JSON.parse(
          await readFile(path.join(root, file), "utf8")
        ) as LabelledDocument
    )
  )
}

/** The manifest's `corpus` hash, which every result cites. */
export async function corpusHash(root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(
      await readFile(path.join(root, "manifest.json"), "utf8")
    )
    return manifest.corpus ?? null
  } catch {
    return null
  }
}

export function gitCommit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim()
  } catch {
    return null
  }
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}
