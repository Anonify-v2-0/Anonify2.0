import type { NormalizedReader } from "@/lib/documents/normalized-store"
import type { CharRange } from "@/lib/documents/shared/text"
import {
  createBudget,
  type CompiledPattern,
  type PatternBudget,
} from "@/lib/redaction/patterns"

/**
 * Finding text in a document, on the server.
 *
 * The viewer only ever holds the pages being looked at, so a search in the
 * browser could only ever search those — and "not found" on page 3 of 400 is
 * precisely the answer that sends a value out unredacted. Search therefore runs
 * where the rules run, over the normalized document a page at a time, with the
 * same compiler; the viewer asks for the hits on the page it is showing.
 *
 * What counts as one hit is what a rule would redact: every match on a page,
 * and a spreadsheet cell once however many times it matches, because a cell is
 * redacted whole. That is what lets "Redact all matches" promise the count the
 * search bar is showing.
 */

/** Far more than anybody pages through; enough to say "narrow it" honestly. */
export const SEARCH_MATCH_LIMIT = 50_000

/** Hits returned for one page. A page is bounded, but a one-character search is not. */
export const PAGE_HIT_LIMIT = 5_000

/** Cell hits returned with a summary; the count is exact either way. */
export const CELL_HIT_LIMIT = 5_000

export type SearchHit = CharRange

export type CellHit = { worksheet: string; row: number; column: number }

export type SearchSummary = {
  /** Hits across the whole document: page matches plus matching cells. */
  total: number
  /** Pages with at least one hit, in page order. */
  pages: { page: number; count: number }[]
  /** Matching cells, in sheet order. At most `CELL_HIT_LIMIT`. */
  cells: CellHit[]
  cellsTruncated: boolean
}

/** One document's line in a search across its batch. */
export type BatchSearchDocument = {
  id: string
  name: string
  status: string
  /** Null when the document cannot be searched yet, or the search gave up. */
  count: number | null
  /** Why `count` is null, for the reviewer. */
  note?: string
}

export function searchBudget(): PatternBudget {
  return createBudget({ matchLimit: SEARCH_MATCH_LIMIT })
}

/** Where every hit in a document is, without the hits on each page. */
export async function summarizeSearch(
  reader: NormalizedReader,
  compiled: CompiledPattern,
  budget: PatternBudget = searchBudget()
): Promise<SearchSummary> {
  const pages: SearchSummary["pages"] = []
  let total = 0

  for await (const page of reader.pages()) {
    const count = compiled.find(page.text, budget).length
    if (count > 0) {
      pages.push({ page: page.number, count })
      total += count
    }
  }

  const cells: CellHit[] = []
  let cellsTruncated = false
  const { sheets } = await reader.outline()
  for (const sheet of sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value || compiled.find(cell.value, budget).length === 0)
        continue
      total += 1
      if (cells.length < CELL_HIT_LIMIT) {
        cells.push({
          worksheet: sheet.name,
          row: cell.row,
          column: cell.column,
        })
      } else {
        cellsTruncated = true
      }
    }
  }

  return { total, pages, cells, cellsTruncated }
}

/** The hits on one page, in order. Empty for a page the document does not have. */
export async function searchPage(
  reader: NormalizedReader,
  compiled: CompiledPattern,
  pageNumber: number
): Promise<SearchHit[]> {
  const page = await reader.page(pageNumber)
  if (!page) return []
  return compiled.find(page.text, searchBudget()).slice(0, PAGE_HIT_LIMIT)
}

// --- previews -----------------------------------------------------------------

/** One match, with enough around it to tell what it is. */
export type MatchSample = {
  page?: number
  worksheet?: string
  row?: number
  column?: number
  before: string
  match: string
  after: string
}

export type MatchPreview = {
  /** Exactly the number of redactions the rule would write here. */
  count: number
  samples: MatchSample[]
}

const CONTEXT_CHARS = 40

/** Whitespace folded, so a match on a line of its own still reads as a line. */
function fold(text: string): string {
  return text.replace(/\s+/g, " ")
}

export function sampleAround(
  text: string,
  range: CharRange,
  context = CONTEXT_CHARS
): Pick<MatchSample, "before" | "match" | "after"> {
  const from = Math.max(0, range.start - context)
  const to = Math.min(text.length, range.end + context)
  return {
    before:
      (from > 0 ? "…" : "") + fold(text.slice(from, range.start)).trimStart(),
    match: text.slice(range.start, range.end),
    after:
      fold(text.slice(range.end, to)).trimEnd() + (to < text.length ? "…" : ""),
  }
}

/**
 * What a rule would do to a document, before it does it: how many redactions
 * and the first few in context. Counted the way `findRuleMatches` writes them,
 * under the same budget, so a preview that succeeds is a rule that will.
 */
export async function previewMatches(
  reader: NormalizedReader,
  compiled: CompiledPattern,
  options: { samples?: number; budget?: PatternBudget } = {}
): Promise<MatchPreview> {
  const limit = options.samples ?? 20
  const budget = options.budget ?? createBudget()
  const samples: MatchSample[] = []
  let count = 0

  for await (const page of reader.pages()) {
    for (const range of compiled.find(page.text, budget)) {
      count += 1
      if (samples.length < limit) {
        samples.push({ page: page.number, ...sampleAround(page.text, range) })
      }
    }
  }

  const { sheets } = await reader.outline()
  for (const sheet of sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      const [first] = compiled.find(cell.value, budget)
      if (!first) continue
      count += 1
      if (samples.length < limit) {
        samples.push({
          worksheet: sheet.name,
          row: cell.row,
          column: cell.column,
          ...sampleAround(cell.value, first),
        })
      }
    }
  }

  return { count, samples }
}

/**
 * Which matches one pattern gains and loses against another, in one document.
 *
 * What "Improve with Hush" shows before anything changes: a tightened pattern
 * is only an improvement if the reviewer can see what it stops redacting.
 */
export async function diffMatches(
  reader: NormalizedReader,
  before: CompiledPattern,
  after: CompiledPattern,
  options: { samples?: number } = {}
): Promise<{
  before: number
  after: number
  gained: MatchSample[]
  lost: MatchSample[]
  gainedCount: number
  lostCount: number
}> {
  const limit = options.samples ?? 20
  const budgetBefore = createBudget()
  const budgetAfter = createBudget()
  const gained: MatchSample[] = []
  const lost: MatchSample[] = []
  let countBefore = 0
  let countAfter = 0
  let gainedCount = 0
  let lostCount = 0

  const key = (range: CharRange) => `${range.start}:${range.end}`

  function compare(
    text: string,
    where: Omit<MatchSample, "before" | "match" | "after">,
    old: CharRange[],
    next: CharRange[]
  ) {
    countBefore += old.length
    countAfter += next.length
    const oldKeys = new Set(old.map(key))
    const nextKeys = new Set(next.map(key))
    for (const range of next) {
      if (oldKeys.has(key(range))) continue
      gainedCount += 1
      if (gained.length < limit)
        gained.push({ ...where, ...sampleAround(text, range) })
    }
    for (const range of old) {
      if (nextKeys.has(key(range))) continue
      lostCount += 1
      if (lost.length < limit)
        lost.push({ ...where, ...sampleAround(text, range) })
    }
  }

  for await (const page of reader.pages()) {
    compare(
      page.text,
      { page: page.number },
      before.find(page.text, budgetBefore),
      after.find(page.text, budgetAfter)
    )
  }

  const { sheets } = await reader.outline()
  for (const sheet of sheets ?? []) {
    for (const cell of sheet.cells) {
      if (!cell.value) continue
      // A cell is one redaction whichever part of it matched, so it is
      // compared as present or absent rather than by where the match fell.
      const old = before.find(cell.value, budgetBefore).slice(0, 1)
      const next = after.find(cell.value, budgetAfter).slice(0, 1)
      const whole = { start: 0, end: cell.value.length }
      compare(
        cell.value,
        { worksheet: sheet.name, row: cell.row, column: cell.column },
        old.length ? [whole] : [],
        next.length ? [whole] : []
      )
    }
  }

  return {
    before: countBefore,
    after: countAfter,
    gained,
    lost,
    gainedCount,
    lostCount,
  }
}
