"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { boxesForRange } from "@/lib/redaction/geometry"
import type { SearchHit } from "@/lib/redaction/search"
import { useAppSelector } from "@/store/hooks"
import { selectCurrentHit, type SearchState } from "@/store/searchSlice"
import type { NormalizedPage } from "@/types/document"
import { cn } from "@/lib/utils"

/**
 * Drawing search hits on the page being shown.
 *
 * Two ways, by what the viewer is:
 *
 *   text flow   DOCX, text, RTF, PPTX, EML. The hit is painted with the CSS
 *               Custom Highlight API over the text nodes already there. The
 *               alternative — splitting spans into pieces to wrap the hit —
 *               would change the elements a click redacts, and a search
 *               should not be able to change what a click does.
 *   geometry    PDF and images. The hit is resolved to rectangles by
 *               `boxesForRange`, the resolution a redaction gets, so a hit and
 *               the redaction it would become cover the same place.
 *
 * Spreadsheets mark cells, in the grid itself.
 */

const HIT = "anonify-search"
const CURRENT = "anonify-search-current"

type WithSearch = { search: SearchState }

/** The hits on one page for the search currently shown, and which is current. */
export function usePageHits(pageNumber: number | undefined): {
  hits: SearchHit[]
  current: number
} {
  const hits = useAppSelector((state: WithSearch) =>
    state.search.open && pageNumber !== undefined
      ? state.search.pageHits[pageNumber]
      : undefined
  )
  const hit = useAppSelector(selectCurrentHit)
  const current =
    hit?.kind === "page" && hit.page === pageNumber ? hit.index : -1
  return { hits: hits ?? EMPTY, current }
}

const EMPTY: SearchHit[] = []

type Segment = { start: number; end: number; node: Text }

/**
 * The page's text as the DOM has it: every text node under an element that
 * says where in the page's text it starts. Viewers mark that with
 * `data-offset`; a DOCX run is found by its span id, and only trusted when it
 * draws the whole span, so a run that was drawn differently is left unpainted
 * rather than painted in the wrong place.
 */
function segmentsOf(root: HTMLElement, page: NormalizedPage): Segment[] {
  const spans = new Map(page.spans.map((span) => [span.id, span]))
  const segments: Segment[] = []

  for (const element of root.querySelectorAll<HTMLElement>(
    "[data-offset], [data-span-id]"
  )) {
    let offset: number | undefined
    if (element.dataset.offset !== undefined) {
      offset = Number(element.dataset.offset)
    } else {
      const span = spans.get(element.dataset.spanId ?? "")
      if (span && element.textContent?.length === span.end - span.start) {
        offset = span.start
      }
    }
    if (offset === undefined || !Number.isFinite(offset)) continue

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node as Text
      // A nested element that says where it starts speaks for its own text.
      if (
        text.parentElement?.closest("[data-offset], [data-span-id]") !== element
      ) {
        continue
      }
      segments.push({ start: offset, end: offset + text.length, node: text })
      offset += text.length
    }
  }

  return segments.sort((a, b) => a.start - b.start)
}

function rangesFor(hit: SearchHit, segments: Segment[]): Range[] {
  const ranges: Range[] = []
  for (const segment of segments) {
    if (segment.end <= hit.start || segment.start >= hit.end) continue
    const range = document.createRange()
    range.setStart(
      segment.node,
      Math.max(hit.start, segment.start) - segment.start
    )
    range.setEnd(segment.node, Math.min(hit.end, segment.end) - segment.start)
    ranges.push(range)
  }
  return ranges
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS
}

/**
 * The two highlights' colors, as a stylesheet added once at runtime.
 *
 * Not in globals.css: the bundler's CSS parser does not know the
 * `::highlight()` pseudo-element yet and drops the rule with a warning, which
 * would leave hits counted in the bar and invisible on the page. The browser
 * knows it, so the rule goes to the browser directly.
 */
const HIGHLIGHT_STYLE_ID = "anonify-search-highlights"
const HIGHLIGHT_CSS = `
::highlight(${HIT}) { background-color: var(--search-hit); }
::highlight(${CURRENT}) { background-color: var(--search-current); color: #111214; }
`

function ensureHighlightStyles() {
  if (document.getElementById(HIGHLIGHT_STYLE_ID)) return
  const style = document.createElement("style")
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = HIGHLIGHT_CSS
  document.head.appendChild(style)
}

/**
 * Paints the page's hits over a text-flow viewer inside `root`, and scrolls
 * the current one into view when it changes. Repaints when the viewer's DOM
 * changes under it — a folded EML section opening, a redaction redrawing —
 * because the ranges point at text nodes, and those can be replaced.
 */
export function useTextHighlights(
  root: RefObject<HTMLElement | null>,
  page: NormalizedPage | undefined,
  enabled: boolean
) {
  const { hits, current } = usePageHits(page?.number)
  const scrolledTo = useRef<string | null>(null)

  useLayoutEffect(() => {
    const container = root.current
    if (!enabled || !container || !page || !highlightsSupported()) return
    ensureHighlightStyles()

    let frame = 0
    const paint = () => {
      const segments = segmentsOf(container, page)
      const all: Range[] = []
      const now: Range[] = []
      hits.forEach((hit, index) => {
        const ranges = rangesFor(hit, segments)
        if (index === current) now.push(...ranges)
        else all.push(...ranges)
      })
      CSS.highlights.set(HIT, new Highlight(...all))
      CSS.highlights.set(CURRENT, new Highlight(...now))

      const identity = `${page.number}:${current}:${hits.length}`
      if (now.length > 0 && scrolledTo.current !== identity) {
        scrolledTo.current = identity
        now[0].startContainer.parentElement?.scrollIntoView({
          block: "center",
          inline: "nearest",
        })
      }
    }

    paint()
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    })
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    })

    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      CSS.highlights.delete(HIT)
      CSS.highlights.delete(CURRENT)
    }
  }, [current, enabled, hits, page, root])
}

/**
 * Hits drawn as rectangles, in page units, for a layer that is already scaled
 * to the page — the PDF annotation layer and the image overlay both are.
 * Never interactive: a hit is not a thing to click, and a box that took
 * pointer events would swallow the click meant for the word under it.
 */
export function SearchBoxes({ page }: { page: NormalizedPage }) {
  const { hits, current } = usePageHits(page.number)
  const currentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center", inline: "nearest" })
  }, [current, hits])

  if (hits.length === 0) return null

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {hits.map((hit, index) =>
        boxesForRange(page, hit.start, hit.end).map((box, part) => (
          <div
            key={`${hit.start}-${hit.end}-${part}`}
            ref={index === current && part === 0 ? currentRef : undefined}
            className={cn(
              "absolute rounded-[1px]",
              index === current
                ? "bg-search-current outline-2 outline-search-current-edge"
                : "bg-search-hit"
            )}
            style={{
              left: box.x,
              top: box.y,
              width: box.width,
              height: box.height,
            }}
          />
        ))
      )}
    </div>
  )
}
