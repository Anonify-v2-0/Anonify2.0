"use client"

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"

import { boxesForRange } from "@/lib/redaction/geometry"
import type { SearchHit } from "@/lib/redaction/search"
import { focusCleared, type EditorFocus } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectCurrentHit, type SearchState } from "@/store/searchSlice"
import type { NormalizedPage } from "@/types/document"
import type { Redaction } from "@/types/redaction"
import { cn } from "@/lib/utils"

/**
 * Drawing search hits — and, in text, redactions — on the page being shown.
 *
 * Two ways, by what the viewer is:
 *
 *   text flow   DOCX, text, RTF, PPTX, EML. Hits and redactions are painted
 *               with the CSS Custom Highlight API over the exact characters
 *               they cover, on the text nodes already there. A span is a whole
 *               line in some formats, and painting the span a redaction
 *               touched blacked out a line to show one ID on it being removed
 *               — a canvas that overstates a redaction is as wrong as one that
 *               understates it. Splitting spans instead would change the
 *               elements a click redacts.
 *   geometry    PDF and images. The hit is resolved to rectangles by
 *               `boxesForRange`, the resolution a redaction gets, so a hit and
 *               the redaction it would become cover the same place.
 *
 * Spreadsheets mark cells, in the grid itself.
 */

const HIT = "anonify-search"
const CURRENT = "anonify-search-current"
const SUGGESTED = "anonify-redaction-suggested"
const ACCEPTED = "anonify-redaction-accepted"
const SELECTED = "anonify-redaction-selected"
const FOCUS = "anonify-focus"

/**
 * Which paint wins where two overlap. A redaction outranks a plain hit, so an
 * accepted value stays black when a search passes over it; the current hit and
 * a focused place outrank everything, so wherever the reviewer is being taken
 * is visible.
 */
const PRIORITY: Record<string, number> = {
  [SUGGESTED]: 0,
  [HIT]: 1,
  [ACCEPTED]: 2,
  [SELECTED]: 3,
  [CURRENT]: 4,
  [FOCUS]: 5,
}

/** How long a focused place stays marked. */
const FOCUS_MS = 2_400

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

/**
 * Where a point in the viewer's DOM — a text node and an offset in it, as a
 * caret or a selection end gives them — is in the page's text. Null for a
 * node the viewer did not mark, rather than a guess.
 */
export function pageOffsetOf(
  root: HTMLElement,
  page: NormalizedPage,
  node: Node,
  nodeOffset: number
): number | null {
  if (node.nodeType !== Node.TEXT_NODE) return null
  const segment = segmentsOf(root, page).find(
    (candidate) => candidate.node === node
  )
  return segment
    ? segment.start + Math.min(nodeOffset, segment.end - segment.start)
    : null
}

/** The text node and offset under a viewport point, from the browser's caret. */
export function caretAt(
  x: number,
  y: number
): { node: Node; offset: number } | null {
  const positioned = document as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number
    ) => { offsetNode: Node; offset: number } | null
    caretRangeFromPoint?: (x: number, y: number) => Range | null
  }
  if (positioned.caretPositionFromPoint) {
    const position = positioned.caretPositionFromPoint(x, y)
    return position
      ? { node: position.offsetNode, offset: position.offset }
      : null
  }
  const range = positioned.caretRangeFromPoint?.(x, y)
  return range
    ? { node: range.startContainer, offset: range.startOffset }
    : null
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
 * The highlights' colors, as a stylesheet added once at runtime.
 *
 * Not in globals.css: the bundler's CSS parser does not know the
 * `::highlight()` pseudo-element yet and drops the rule with a warning, which
 * would leave hits counted in the bar and invisible on the page. The browser
 * knows it, so the rule goes to the browser directly.
 */
const HIGHLIGHT_STYLE_ID = "anonify-search-highlights"
const HIGHLIGHT_CSS = [
  `::highlight(${HIT}) { background-color: var(--search-hit); }`,
  `::highlight(${CURRENT}) { background-color: var(--search-current); color: #111214; }`,
  `::highlight(${SUGGESTED}) { background-color: var(--red-soft); text-decoration: underline dashed var(--red-border); text-decoration-thickness: 1px; text-underline-offset: 3px; }`,
  `::highlight(${ACCEPTED}) { background-color: #000; color: #000; }`,
  `::highlight(${SELECTED}) { background-color: rgba(255, 0, 0, 0.32); text-decoration: underline solid #ff0000; text-decoration-thickness: 2px; text-underline-offset: 3px; }`,
  `::highlight(${FOCUS}) { background-color: var(--search-current); color: #111214; }`,
].join("\n")

function ensureHighlightStyles() {
  const existing = document.getElementById(HIGHLIGHT_STYLE_ID)
  if (existing?.textContent === HIGHLIGHT_CSS) return
  const style = existing ?? document.createElement("style")
  style.id = HIGHLIGHT_STYLE_ID
  style.textContent = HIGHLIGHT_CSS
  if (!existing) document.head.appendChild(style)
}

function setHighlight(name: string, ranges: Range[]) {
  const highlight = new Highlight(...ranges)
  highlight.priority = PRIORITY[name] ?? 0
  CSS.highlights.set(name, highlight)
}

/** The focused place, while it is on this page and still marked. */
export function usePageFocus(
  pageNumber: number | undefined
): Extract<EditorFocus, { kind: "text" }> | null {
  const dispatch = useAppDispatch()
  const focus = useAppSelector((state) => state.editor.focus)

  // A mark, not a state: it goes on its own after a moment.
  useEffect(() => {
    if (!focus) return
    const timer = setTimeout(
      () => dispatch(focusCleared(focus.nonce)),
      FOCUS_MS
    )
    return () => clearTimeout(timer)
  }, [dispatch, focus])

  return focus?.kind === "text" && focus.page === pageNumber ? focus : null
}

/**
 * Paints a text-flow viewer inside `root`: search hits, the current hit,
 * redactions by their exact characters, the selected one, and a focused place.
 * Scrolls a newly focused place, or the current hit, into view.
 *
 * Repaints when the viewer's DOM changes under it — a folded EML section
 * opening, a span redrawing — because the ranges point at text nodes, and
 * those can be replaced.
 */
export function useTextHighlights(
  root: RefObject<HTMLElement | null>,
  page: NormalizedPage | undefined,
  enabled: boolean,
  redactions: Redaction[] = NO_REDACTIONS,
  selectedId: string | null = null
) {
  const { hits, current } = usePageHits(page?.number)
  const focus = usePageFocus(page?.number)
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
        const found = rangesFor(hit, segments)
        if (index === current) now.push(...found)
        else all.push(...found)
      })

      const suggested: Range[] = []
      const accepted: Range[] = []
      const selected: Range[] = []
      for (const redaction of redactions) {
        if (redaction.start === undefined || redaction.end === undefined)
          continue
        if (redaction.status === "rejected") continue
        const found = rangesFor(
          { start: redaction.start, end: redaction.end },
          segments
        )
        if (redaction.id === selectedId) selected.push(...found)
        else if (redaction.status === "accepted") accepted.push(...found)
        else suggested.push(...found)
      }

      const focused = focus
        ? rangesFor({ start: focus.start, end: focus.end }, segments)
        : []

      setHighlight(HIT, all)
      setHighlight(CURRENT, now)
      setHighlight(SUGGESTED, suggested)
      setHighlight(ACCEPTED, accepted)
      setHighlight(SELECTED, selected)
      setHighlight(FOCUS, focused)

      // A focused place wins: it was asked for just now. Otherwise the
      // current hit, once per hit.
      const target = focused[0] ?? now[0]
      const identity = focused[0]
        ? `focus:${focus?.nonce}`
        : `${page.number}:${current}:${hits.length}`
      if (target && scrolledTo.current !== identity) {
        scrolledTo.current = identity
        target.startContainer.parentElement?.scrollIntoView({
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
      for (const name of Object.keys(PRIORITY)) CSS.highlights.delete(name)
    }
  }, [current, enabled, focus, hits, page, redactions, root, selectedId])
}

const NO_REDACTIONS: Redaction[] = []

/**
 * Hits drawn as rectangles, in page units, for a layer that is already scaled
 * to the page — the PDF annotation layer and the image overlay both are.
 * Never interactive: a hit is not a thing to click, and a box that took
 * pointer events would swallow the click meant for the word under it. A
 * focused place is drawn the same way, pulsing until it clears.
 */
export function SearchBoxes({ page }: { page: NormalizedPage }) {
  const { hits, current } = usePageHits(page.number)
  const focus = usePageFocus(page.number)
  const currentRef = useRef<HTMLDivElement>(null)
  const focusRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "center", inline: "nearest" })
  }, [current, hits])

  useEffect(() => {
    focusRef.current?.scrollIntoView({ block: "center", inline: "nearest" })
  }, [focus?.nonce])

  if (hits.length === 0 && !focus) return null

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
      {focus
        ? boxesForRange(page, focus.start, focus.end).map((box, part) => (
            <div
              key={`focus-${focus.nonce}-${part}`}
              ref={part === 0 ? focusRef : undefined}
              className="absolute animate-pulse rounded-[1px] bg-search-current outline-2 outline-search-current-edge"
              style={{
                left: box.x,
                top: box.y,
                width: box.width,
                height: box.height,
              }}
            />
          ))
        : null}
    </div>
  )
}
