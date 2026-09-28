/**
 * Renders corpus documents to the files a person would upload (issue #57).
 *
 *   pnpm corpus:render                         # every document, to every format it lists
 *   pnpm corpus:render --format pdf            # only PDFs
 *   pnpm corpus:render --ids syn-v1-0042 --out /tmp/look
 *
 * Nothing rendered is committed: the corpus is the text and its labels, and
 * the files are made from them, the same bytes every time (lib/render.ts).
 * By default they go to benchmarks/corpus/.cache/<corpus>/render/<format>/,
 * which git ignores. `pnpm corpus:score --format <format>` renders on the fly
 * and does not need this; it is for looking at what the scorer is given.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { syncBeforeRun } from "./lib/archive"
import { listDocumentFiles } from "./lib/manifest"
import {
  isRenderFormat,
  RENDER_FORMATS,
  renderDocument,
  type RenderFormat,
} from "./lib/render"
import { palette, progressBar } from "./lib/tui"
import type { LabelledDocument } from "./lib/types"

const HERE = import.meta.dirname

const USAGE = `Usage: pnpm corpus:render [options]

  --format <name>   ${RENDER_FORMATS.join(", ")}; repeatable. Default: each
                    document's own list (its "render" field)
  --all-formats     every format for every document, listed or not
  --corpus <dir>    corpus directory (default benchmarks/corpus/synthetic-v1)
  --split <name>    dev, test or all (default all)
  --ids <a,b,...>   only these documents
  --out <dir>       where to write (default benchmarks/corpus/.cache/<corpus>/render)
`

async function main() {
  const { values } = parseArgs({
    options: {
      format: { type: "string", multiple: true, default: [] },
      "all-formats": { type: "boolean", default: false },
      corpus: { type: "string", default: path.join(HERE, "synthetic-v1") },
      split: { type: "string", default: "all" },
      ids: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  for (const format of values.format) {
    if (!isRenderFormat(format))
      throw new Error(
        `--format must be one of ${RENDER_FORMATS.join(", ")}, not ${JSON.stringify(format)}`
      )
  }
  const root = path.resolve(values.corpus)
  const out = path.resolve(
    values.out ?? path.join(HERE, ".cache", path.basename(root), "render")
  )
  await syncBeforeRun(root)

  const wanted = values.ids
    ? new Set(values.ids.split(",").map((id) => id.trim()))
    : null
  const files = (await listDocumentFiles(root)).filter(
    (file) =>
      (values.split === "all" || file.startsWith(`${values.split}/`)) &&
      (!wanted || wanted.has(path.basename(file, ".json")))
  )

  const c = palette()
  const counts = new Map<RenderFormat, number>()
  let substituted = 0
  let done = 0
  const live = process.stdout.isTTY && !process.env.CI
  for (const file of files) {
    const document = JSON.parse(
      await readFile(path.join(root, file), "utf8")
    ) as LabelledDocument
    const formats: readonly RenderFormat[] = values["all-formats"]
      ? RENDER_FORMATS
      : values.format.length
        ? (values.format as RenderFormat[]).filter((format) =>
            document.render.includes(format)
          )
        : document.render
    for (const format of formats) {
      const rendered = await renderDocument(document, format)
      await mkdir(path.join(out, format), { recursive: true })
      await writeFile(path.join(out, format, rendered.filename), rendered.bytes)
      counts.set(format, (counts.get(format) ?? 0) + 1)
      substituted += rendered.substituted
    }
    done++
    if (live)
      process.stdout.write(
        `\r  ${progressBar(done / files.length, 32, done, c)} ${done}/${files.length}\x1b[K`
      )
  }
  if (live) process.stdout.write("\r\x1b[K")

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  console.log(
    `Rendered ${total} files from ${files.length} documents: ${[...counts].map(([format, n]) => `${format} ${n}`).join(", ") || "none"}.`
  )
  if (substituted)
    console.log(
      c.dim(
        `${substituted} character(s) a format could not carry were written as "?".`
      )
    )
  console.log(c.dim(path.relative(process.cwd(), out)))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
