"use client"

import { useEffect, useMemo, useRef, useState, type ComponentProps } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"

import { PageThumbnail } from "@/components/editor/page-thumbnail"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Sheet } from "@/components/ui/sheet"
import { useNormalizedPage } from "@/hooks/use-normalized-document"
import { usePdfDocument } from "@/hooks/use-pdf-document"
import { pageChanged } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectRedactions } from "@/store/selectors"
import { pagePanelToggled } from "@/store/uiSlice"
import type { RootState } from "@/store/store"

/**
 * The page rail.
 *
 * Thumbnails carry the accepted redactions, so the rail is also a progress
 * view — a glance shows which pages have been worked through. It is a real
 * navigation list, so a keyboard user can tab through pages and a screen reader
 * hears how many redactions each one holds.
 */
/** Which pages the document has, in order; shared by the rail, the sheet and the stepper. */
function usePageNumbers(documentId: string): number[] {
  const summary = useAppSelector((state) => state.document.summary)
  const normalized = useAppSelector((state) => state.document.normalized)
  return useMemo(
    () =>
      normalized?.documentId === documentId
        ? normalized.pageNumbers
        : Array.from({ length: summary?.pageCount ?? 0 }, (_, index) => index + 1),
    [documentId, normalized, summary?.pageCount]
  )
}

const selectHitsByPage = (state: RootState) =>
  state.search.open ? state.search.pages : null

/** Every page as a thumbnail, with its redactions and search hits. */
function PageList({
  documentId,
  layout,
  onPicked,
}: {
  documentId: string
  layout: "rail" | "grid"
  onPicked?: () => void
}) {
  const dispatch = useAppDispatch()
  const currentPage = useAppSelector((state) => state.editor.currentPage)
  const summary = useAppSelector((state) => state.document.summary)
  const redactions = useAppSelector(selectRedactions)
  // Search hits per page, so a long document shows where they are at a glance.
  const hitsByPage = useAppSelector(selectHitsByPage)
  const pageNumbers = usePageNumbers(documentId)

  const isPdf = summary?.kind === "pdf"
  const { pdf } = usePdfDocument(documentId, isPdf)

  const byPage = useMemo(() => {
    const grouped = new Map<number, typeof redactions>()
    for (const redaction of redactions) {
      if (redaction.status === "rejected") continue
      const page = redaction.page ?? 1
      grouped.set(page, [...(grouped.get(page) ?? []), redaction])
    }
    return grouped
  }, [redactions])

  return (
    <ul
      className={
        layout === "rail"
          ? "flex flex-col gap-3 px-4 pb-4"
          : "grid grid-cols-3 gap-3 p-4 sm:grid-cols-4"
      }
    >
      {pageNumbers.map((pageNumber) => (
        <li key={pageNumber} className="relative">
          <SearchBadge
            count={hitsByPage?.find((entry) => entry.page === pageNumber)?.count}
          />
          <RailThumbnail
            documentId={documentId}
            pageNumber={pageNumber}
            redactions={byPage.get(pageNumber) ?? []}
            selected={pageNumber === currentPage}
            pdf={pdf}
            textPreview={
              summary?.kind === "txt" ||
              summary?.kind === "rtf" ||
              summary?.kind === "pptx"
            }
            onSelect={() => {
              dispatch(pageChanged(pageNumber))
              onPicked?.()
            }}
          />
        </li>
      ))}
    </ul>
  )
}

export function PageNavigator({ documentId }: { documentId: string }) {
  const pageCount = usePageNumbers(documentId).length
  if (pageCount === 0) return null

  return (
    <aside className="hidden w-[168px] shrink-0 flex-col border-r border-border bg-surface-2 lg:flex">
      <p className="label-micro px-4 py-3" id="page-rail-label">
        Pages
      </p>

      <ScrollArea className="flex-1">
        <nav aria-labelledby="page-rail-label">
          <PageList documentId={documentId} layout="rail" />
        </nav>
      </ScrollArea>
    </aside>
  )
}

/**
 * The pages on a screen with no room for the rail: the same thumbnails, as a
 * grid in a sheet. Opened from the stepper's page count.
 */
export function PagesSheet({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const open = useAppSelector((state) => state.ui.pagePanelOpen)
  const pageCount = usePageNumbers(documentId).length
  const close = () => dispatch(pagePanelToggled(false))

  if (pageCount < 2) return null

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => dispatch(pagePanelToggled(next))}
      title={`Pages (${pageCount})`}
      snaps={["half", "full"]}
      modal
      className="lg:hidden"
    >
      <nav aria-label="Pages" className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <PageList documentId={documentId} layout="grid" onPicked={close} />
      </nav>
    </Sheet>
  )
}

/**
 * ‹ 3 / 12 › over the bottom of the canvas, wherever the rail is hidden. The
 * count opens every page as a grid. Without this a multi-page document on a
 * phone was stuck on page 1: the rail was the only page control that was not
 * a keyboard shortcut.
 */
export function PageStepper({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const currentPage = useAppSelector((state) => state.editor.currentPage)
  const pageNumbers = usePageNumbers(documentId)
  if (pageNumbers.length < 2) return null

  const index = Math.max(0, pageNumbers.indexOf(currentPage))
  const previous = pageNumbers[index - 1]
  const next = pageNumbers[index + 1]
  const step =
    "flex size-11 items-center justify-center rounded-full text-white transition-colors hover:bg-white/10 disabled:text-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

  return (
    <nav
      aria-label="Page"
      className="pointer-events-auto absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center rounded-full border border-border bg-surface-3/95 shadow-panel backdrop-blur lg:hidden"
    >
      <button
        type="button"
        disabled={previous === undefined}
        onClick={() => previous !== undefined && dispatch(pageChanged(previous))}
        className={step}
      >
        <ChevronLeft className="size-5" />
        <span className="sr-only">Previous page</span>
      </button>
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={() => dispatch(pagePanelToggled(true))}
        className="flex h-11 min-w-16 items-center justify-center rounded-full px-2 text-sm text-white tabular-nums transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span aria-hidden>
          {index + 1} / {pageNumbers.length}
        </span>
        <span className="sr-only">
          Page {index + 1} of {pageNumbers.length}. Show all pages
        </span>
      </button>
      <button
        type="button"
        disabled={next === undefined}
        onClick={() => next !== undefined && dispatch(pageChanged(next))}
        className={step}
      >
        <ChevronRight className="size-5" />
        <span className="sr-only">Next page</span>
      </button>
    </nav>
  )
}

/**
 * A thumbnail that fetches its page once it is nearly in view.
 *
 * The rail lists every page, and a rail that fetched every page would be the
 * whole model again by another route. A tile far down a long document asks
 * for its page when the reader scrolls towards it, and not before.
 */
function RailThumbnail(props: Omit<ComponentProps<typeof PageThumbnail>, "page">) {
  const anchor = useRef<HTMLDivElement>(null)
  const [near, setNear] = useState(false)

  useEffect(() => {
    const element = anchor.current
    if (!element || near) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true)
      },
      { rootMargin: "400px 0px" }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [near])

  const page = useNormalizedPage(props.documentId, props.pageNumber, near)

  return (
    <div ref={anchor}>
      <PageThumbnail {...props} page={page ?? undefined} />
    </div>
  )
}

/** How many search hits a page holds, over its thumbnail. */
function SearchBadge({ count }: { count: number | undefined }) {
  if (!count) return null
  return (
    <span
      className="pointer-events-none absolute top-1.5 right-1.5 z-10 min-w-5 rounded-full bg-search-current px-1.5 py-px text-center text-[10px] font-semibold text-surface-3 tabular-nums shadow-sm"
    >
      {count > 99 ? "99+" : count}
      <span className="sr-only"> search {count === 1 ? "match" : "matches"}</span>
    </span>
  )
}
