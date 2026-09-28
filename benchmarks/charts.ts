/**
 * Draws the benchmark charts from the committed results (issues #59, #55).
 *
 *   pnpm bench:charts           # redraw benchmarks/charts/ and the README sections
 *   pnpm bench:charts --check   # fail if they are out of date with the results
 *
 * Reads every file `pnpm bench:models` wrote for one corpus, split and format,
 * and the deterministic baseline `pnpm corpus:score` wrote beside them. Each
 * chart is written twice, light and dark, and the generated sections of
 * benchmarks/README.md and README.md are rewritten to show them with the
 * numbers behind each. Nothing here calls a model: the charts are always
 * redrawn from what is committed, so they cannot say more than the data does.
 */

import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

import { isRenderFormat, RENDER_FORMATS } from "./corpus/lib/render"
import { box, palette } from "./corpus/lib/tui"
import { resultsDirectory, type ModelResults } from "./lib/bench"
import { corpusHash, parseSplit } from "./lib/corpus"
import {
  benchmarksMarkdown,
  buildReport,
  replaceSection,
  rootMarkdown,
  type PatternsBaseline,
} from "./lib/report"

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, "..")
const CHARTS = path.join(HERE, "charts")

const USAGE = `Usage: pnpm bench:charts [options]

  --corpus <dir>   corpus directory (default benchmarks/corpus/synthetic-v1)
  --split <name>   test (default), dev or all
  --format <name>  text (default) or ${RENDER_FORMATS.join(", ")}
  --check          change nothing; exit 1 if a chart or README section is out of date
`

async function main() {
  const { values } = parseArgs({
    options: {
      corpus: {
        type: "string",
        default: path.join(HERE, "corpus", "synthetic-v1"),
      },
      split: { type: "string", default: "test" },
      format: { type: "string", default: "text" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  })
  if (values.help) {
    process.stdout.write(USAGE)
    return
  }
  const c = palette()
  const split = parseSplit(values.split)
  const format = values.format
  if (format !== "text" && !isRenderFormat(format))
    throw new Error(
      `--format must be text or one of ${RENDER_FORMATS.join(", ")}`
    )

  const root = path.resolve(values.corpus)
  const corpus = path.basename(root)
  // The manifest is committed as plain text, so this needs no unpacking.
  const hash = await corpusHash(root)
  const directory = path.join(
    HERE,
    "results",
    "models",
    resultsDirectory(corpus, split, format)
  )
  const files = existsSync(directory)
    ? (await readdir(directory)).filter((f) => f.endsWith(".json")).sort()
    : []
  const results = await Promise.all(
    files.map(
      async (f) =>
        JSON.parse(
          await readFile(path.join(directory, f), "utf8")
        ) as ModelResults
    )
  )
  const baselineFile = path.join(
    HERE,
    "results",
    `${corpus}-${split}-patterns${format === "text" ? "" : `-${format}`}.json`
  )
  const baseline = existsSync(baselineFile)
    ? (JSON.parse(await readFile(baselineFile, "utf8")) as PatternsBaseline)
    : null

  const context = `${corpus}, ${split} split${format === "text" ? "" : `, as ${format}`}`
  const report = buildReport({ results, baseline, corpusHash: hash, context })
  const sources = `\`${path.relative(REPO, directory).replace(/\\/g, "/")}/\`${baseline ? ` and \`${path.relative(REPO, baselineFile).replace(/\\/g, "/")}\`` : ""}`

  const wanted = new Map<string, string>()
  for (const chart of report.charts)
    for (const [theme, svg] of Object.entries(chart.svg))
      wanted.set(`${chart.name}-${theme}.svg`, `${svg}\n`)
  const documents = [
    {
      file: path.join(HERE, "README.md"),
      section: benchmarksMarkdown(report, context, sources),
    },
    { file: path.join(REPO, "README.md"), section: rootMarkdown(report) },
  ]

  const stale: string[] = []
  const existing = existsSync(CHARTS)
    ? (await readdir(CHARTS)).filter((f) => /-(light|dark)\.svg$/.test(f))
    : []
  for (const [name, svg] of wanted) {
    const file = path.join(CHARTS, name)
    if (!existsSync(file) || (await readFile(file, "utf8")) !== svg)
      stale.push(`benchmarks/charts/${name}`)
  }
  for (const name of existing)
    if (!wanted.has(name))
      stale.push(`benchmarks/charts/${name} (no longer drawn)`)
  const rewritten = await Promise.all(
    documents.map(async (d) => {
      const before = await readFile(d.file, "utf8")
      return { ...d, before, after: replaceSection(before, d.section) }
    })
  )
  for (const d of rewritten)
    if (d.before !== d.after)
      stale.push(path.relative(REPO, d.file).replace(/\\/g, "/"))

  if (values.check) {
    if (stale.length === 0) {
      console.log(
        c.green("✓ the charts and README sections match the committed results")
      )
      return
    }
    console.log(
      c.red(
        `✗ out of date with the results; run pnpm bench:charts:\n${stale.map((s) => `  ${s}`).join("\n")}`
      )
    )
    process.exitCode = 1
    return
  }

  await mkdir(CHARTS, { recursive: true })
  for (const [name, svg] of wanted)
    await writeFile(path.join(CHARTS, name), svg)
  for (const name of existing)
    if (!wanted.has(name)) await rm(path.join(CHARTS, name))
  for (const d of rewritten)
    if (d.before !== d.after) await writeFile(d.file, d.after)

  const lines = [
    `${c.dim("from")} ${report.models.length} model${report.models.length === 1 ? "" : "s"} in ${path.relative(REPO, directory).replace(/\\/g, "/")}${baseline ? c.dim(" + the patterns baseline") : ""}`,
    "",
    ...report.charts.map(
      (chart) =>
        `${c.green("✓")} ${chart.title}  ${c.dim(`charts/${chart.name}-{light,dark}.svg`)}`
    ),
    ...report.missing.map(
      (m) => `${c.gray("·")} ${c.dim(`${m.title}: needs ${m.needs}`)}`
    ),
    ...report.excluded.map((e) => `${c.yellow("!")} ${e.model}: ${e.reason}`),
    ...report.caveats.map((caveat) => `${c.yellow("!")} ${caveat}`),
    "",
    stale.length
      ? `${c.dim("updated")} ${stale.length} file${stale.length === 1 ? "" : "s"}`
      : c.dim("everything was already up to date"),
  ]
  console.log(box(lines, c, "bench:charts"))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
