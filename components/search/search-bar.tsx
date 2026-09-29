"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import Link from "next/link"
import {
  AlertCircle,
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Layers,
  ListTree,
  Loader2,
  Regex,
  Search,
  WholeWord,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Sheet } from "@/components/ui/sheet"
import { useMediaQuery } from "@/hooks/use-media-query"
import { RESULTS_COLUMN } from "@/lib/editor/layout"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { shortcutHint } from "@/lib/editor/shortcuts"
import type { ListedHit } from "@/lib/redaction/search"
import { cn } from "@/lib/utils"
import { useAppDispatch, useAppSelector, useAppStore } from "@/store/hooks"
import {
  batchSearchToggled,
  currentChanged,
  optionsChanged,
  queryChanged,
  resultsToggled,
  searchClosed,
  selectCurrentHit,
  specOfSearch,
} from "@/store/searchSlice"
import { ruleDialogOpened } from "@/store/uiSlice"
import type { Redaction } from "@/types/redaction"

/**
 * Find, for the review screen.
 *
 * It replaces the browser's find, which cannot read a PDF page (text drawn on
 * a canvas) or pages that are not loaded — so on the one screen where "not
 * found" matters most, it would say it with confidence and be wrong.
 *
 * A strip docked over the canvas rather than a floating card: the document
 * stays where it is, and the strip reads as part of the tool rather than a
 * dialog over it. Under it, the results — every hit in context, grouped by
 * page — and across the batch when asked. From here a hit becomes a decision
 * in one step: redact this one, or open a rule for all of them with every
 * match previewed before anything is written.
 */

function OptionToggle({
  pressed,
  label,
  hint,
  onClick,
  children,
}: {
  pressed: boolean
  label: string
  hint: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-pressed={pressed}
            onClick={onClick}
            className={cn(
              "flex size-7 items-center justify-center rounded-[5px] transition-colors pointer-coarse:size-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
              pressed
                ? "bg-white/12 text-white"
                : "text-text-muted hover:bg-white/5 hover:text-white"
            )}
          >
            {children}
            <span className="sr-only">{label}</span>
          </button>
        }
      />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  )
}

function IconButton({
  label,
  hint,
  disabled,
  onClick,
  pressed,
  children,
}: {
  label: string
  hint?: string
  disabled?: boolean
  onClick: () => void
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
            className={cn(pressed && "bg-white/10 text-white")}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Button>
        }
      />
      <TooltipContent>{hint ?? label}</TooltipContent>
    </Tooltip>
  )
}

export function SearchBar({
  batchId,
  onNext,
  onPrevious,
  onRedact,
}: {
  batchId: string | null
  onNext: () => void
  onPrevious: () => void
  onRedact: (input: Omit<Redaction, "id" | "documentId">) => void
}) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const search = useAppSelector((state) => state.search)
  const hit = useAppSelector(selectCurrentHit)
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!search.open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [search.focusRequest, search.open])

  if (!search.open) return null

  const ready = search.status === "ready" && search.total > 0
  const currentLoaded =
    hit?.kind === "cell" ||
    (hit?.kind === "page" && search.pageHits[hit.page]?.[hit.index] !== undefined)

  function close() {
    dispatch(searchClosed())
  }

  /** The current hit, made a manual redaction, if it can be located. */
  function redactCurrent() {
    const state = store.getState()
    if (!hit) return
    if (hit.kind === "page") {
      const range = state.search.pageHits[hit.page]?.[hit.index]
      const text = state.document.pages[hit.page]?.text
      if (!range || text === undefined) return
      onRedact({
        type: "text",
        source: "user",
        category: "other",
        status: "accepted",
        page: hit.page,
        text: text.slice(range.start, range.end),
        start: range.start,
        end: range.end,
      })
    } else {
      const sheet = state.document.normalized?.sheets?.find(
        (candidate) => candidate.name === hit.cell.worksheet
      )
      const value = sheet?.cells.find(
        (cell) => cell.row === hit.cell.row && cell.column === hit.cell.column
      )?.value
      onRedact({
        type: "cell",
        source: "user",
        category: "other",
        status: "accepted",
        worksheet: hit.cell.worksheet,
        row: hit.cell.row,
        column: hit.cell.column,
        text: value ?? undefined,
      })
    }
    onNext()
  }

  /**
   * The search, as the rule it would become. The options travel with it, so
   * the rule redacts exactly what was found — the count on the button is the
   * count the dialog previews.
   */
  function redactAll() {
    dispatch(
      ruleDialogOpened({
        mode: "create",
        spec: specOfSearch(search),
        category: "other",
        scope: "document",
      })
    )
  }

  // Drawn in the field on a wide screen and in the second row on a phone;
  // only one of the two is ever visible.
  const options = (
    <>
            <OptionToggle
        pressed={search.matchCase}
        label="Match case"
        hint="Match case"
        onClick={() => dispatch(optionsChanged({ matchCase: !search.matchCase }))}
      >
        <CaseSensitive className="size-4" />
      </OptionToggle>
      <OptionToggle
        pressed={search.wholeWord}
        label="Whole word"
        hint="Whole word"
        onClick={() => dispatch(optionsChanged({ wholeWord: !search.wholeWord }))}
      >
        <WholeWord className="size-4" />
      </OptionToggle>
      <OptionToggle
        pressed={search.regex}
        label="Regular expression"
        hint="Regular expression (RE2)"
        onClick={() => dispatch(optionsChanged({ regex: !search.regex }))}
      >
        <Regex className="size-4" />
      </OptionToggle>
    </>
  )

  return (
    <div role="search" aria-label="Search this document" className="relative z-20 shrink-0">
      <div className="flex min-h-12 items-center gap-2 border-b border-border bg-surface-2 px-3 compact:gap-0.5 compact:border-b-0 compact:px-2 compact:pt-1">
        <label
          className={cn(
            "flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border bg-surface-3 px-2.5 transition-colors focus-within:border-white/30 pointer-coarse:h-11",
            search.status === "error" ? "border-red-border" : "border-border"
          )}
        >
          {search.status === "searching" ? (
            <Loader2 aria-hidden className="size-4 shrink-0 animate-spin text-text-muted" />
          ) : (
            <Search aria-hidden className="size-4 shrink-0 text-text-muted" />
          )}
          <input
            ref={inputRef}
            type="search"
            value={search.query}
            placeholder={
              search.regex ? "RegEx, e.g. EMP-\\d{5}" : "Find in the whole document"
            }
            aria-label="Find in the whole document"
            aria-describedby="search-status"
            aria-invalid={search.status === "error" || undefined}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => dispatch(queryChanged(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                if (event.shiftKey) onPrevious()
                else onNext()
              } else if (event.key === "Escape") {
                event.preventDefault()
                close()
              } else if (
                (event.metaKey || event.ctrlKey) &&
                event.key.toLowerCase() === "f"
              ) {
                // Already here: select the query rather than open the
                // browser's find, which cannot read this page.
                event.preventDefault()
                inputRef.current?.select()
              }
            }}
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden",
              search.regex && "font-mono"
            )}
          />
          <span
            id="search-status"
            className={cn(
              "shrink-0 text-xs tabular-nums",
              search.status === "error" ? "sr-only" : "text-text-muted"
            )}
          >
            {search.status === "ready"
              ? search.total === 0
                ? "No matches"
                : `${search.current + 1} / ${search.total.toLocaleString("en")}`
              : search.status === "error"
                ? search.error
                : ""}
          </span>
          <span aria-hidden className="h-4 w-px shrink-0 bg-border compact:hidden" />
          <span role="group" aria-label="Search options" className="flex shrink-0 gap-0.5 compact:hidden">
            {options}
          </span>
        </label>

        <div className="flex shrink-0 items-center">
          <IconButton
            label="Previous match"
            hint={`Previous (${shortcutHint("search-previous")})`}
            disabled={!ready}
            onClick={onPrevious}
          >
            <ChevronUp className="size-4" />
          </IconButton>
          <IconButton
            label="Next match"
            hint={`Next (${shortcutHint("search-next")})`}
            disabled={!ready}
            onClick={onNext}
          >
            <ChevronDown className="size-4" />
          </IconButton>
        </div>

        <div className="flex shrink-0 items-center overflow-hidden rounded-md border border-border compact:hidden">
          <button
            type="button"
            disabled={!ready || !currentLoaded}
            onClick={redactCurrent}
            className="flex h-8 items-center pointer-coarse:h-11 gap-1.5 px-2.5 text-xs text-white transition-colors hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40"
          >
            <span aria-hidden className="h-2.5 w-3.5 rounded-[1px] bg-current" />
            Redact this
          </button>
          <span aria-hidden className="h-5 w-px bg-border" />
          <button
            type="button"
            disabled={!ready}
            onClick={redactAll}
            className="flex h-8 items-center pointer-coarse:h-11 gap-1.5 bg-red-soft px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-40"
          >
            Redact all{ready ? ` ${search.total.toLocaleString("en")}` : ""}
          </button>
        </div>

        <div className="flex shrink-0 items-center">
          <IconButton
            label="Show results"
            pressed={search.resultsOpen}
            onClick={() => dispatch(resultsToggled())}
          >
            <ListTree className="size-4" />
          </IconButton>
          {inBatch && batchId ? (
            <IconButton
              label="Search the whole batch"
              pressed={search.batch.open}
              onClick={() => dispatch(batchSearchToggled())}
            >
              <Layers className="size-4" />
            </IconButton>
          ) : null}
          <IconButton
            label="Close search"
            hint={`Close (${shortcutHint("search-close")})`}
            onClick={close}
          >
            <X className="size-4" />
          </IconButton>
        </div>
      </div>

      {/*
        The second row on a phone: the match options and the two ways to act
        on what was found. Both used to be hidden below 640 px, so a phone
        could find a value and do nothing with it.
      */}
      <div className="hidden items-center gap-2 border-b border-border bg-surface-2 px-2 pb-1 compact:flex">
        <span role="group" aria-label="Search options" className="flex shrink-0 gap-0.5">
          {options}
        </span>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden rounded-md border border-border">
          <button
            type="button"
            disabled={!ready || !currentLoaded}
            onClick={redactCurrent}
            className="flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-xs whitespace-nowrap text-white transition-colors hover:bg-white/5 disabled:pointer-events-none disabled:opacity-40"
          >
            <span aria-hidden className="h-2.5 w-3.5 shrink-0 rounded-[1px] bg-current" />
            Redact this
          </button>
          <span aria-hidden className="h-6 w-px shrink-0 bg-border" />
          <button
            type="button"
            disabled={!ready}
            onClick={redactAll}
            className="flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 bg-red-soft px-2 text-xs font-medium whitespace-nowrap text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-40"
          >
            Redact all{ready ? ` ${search.total.toLocaleString("en")}` : ""}
          </button>
        </div>
      </div>

      {search.status === "error" ? (
        <p
          role="alert"
          className="flex items-center gap-2 border-b border-red-border/40 bg-red-soft px-4 py-1.5 text-xs text-text-secondary"
        >
          <AlertCircle className="size-3.5 shrink-0 text-primary" />
          {search.error}
        </p>
      ) : null}

    </div>
  )
}

function where(hit: ListedHit): string {
  return hit.worksheet ? `${hit.worksheet} · R${hit.row}C${hit.column}` : `Page ${hit.page}`
}

/**
 * The results, docked beside the canvas rather than floating over it: a list
 * that covered the right half of the page hid the very text it was listing.
 * Rendered by the workspace next to the canvas; nothing when there is nothing
 * to list or the reviewer has closed it.
 */
export function SearchResults({ batchId }: { batchId: string | null }) {
  const search = useAppSelector((state) => state.search)
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  const show =
    search.open &&
    Boolean(search.query) &&
    (search.resultsOpen || search.batch.open) &&
    (search.status === "ready" || search.batch.open)
  return (
    <ResultsPlacement show={show} inBatch={inBatch && Boolean(batchId)} />
  )
}

/**
 * A column beside the page where there is room for one, and a sheet over it
 * on a phone, where a 320 px column would be the whole screen. Below 768 px
 * there used to be no list at all.
 */
function ResultsPlacement({ show, inBatch }: { show: boolean; inBatch: boolean }) {
  const dispatch = useAppDispatch()
  const batchOpen = useAppSelector((state) => state.search.batch.open)
  const column = useMediaQuery(RESULTS_COLUMN)

  if (column) return show ? <ResultsPanel inBatch={inBatch} variant="column" /> : null

  return (
    <Sheet
      open={show}
      onOpenChange={(open) => {
        if (open) return
        dispatch(resultsToggled(false))
        if (batchOpen) dispatch(batchSearchToggled(false))
      }}
      title="Search results"
      snaps={["peek", "half", "full"]}
      initialSnap="half"
    >
      <ResultsPanel inBatch={inBatch} variant="sheet" />
    </Sheet>
  )
}

/**
 * Every hit in context, grouped by where it is. Clicking one makes it the
 * current hit, which moves the page to it; the current one is marked here as
 * it is on the page.
 */
function ResultsPanel({
  inBatch,
  variant,
}: {
  inBatch: boolean
  variant: "column" | "sheet"
}) {
  const dispatch = useAppDispatch()
  const search = useAppSelector((state) => state.search)
  const [tab, setTab] = useState<"document" | "batch">(
    search.batch.open ? "batch" : "document"
  )
  const active = search.batch.open && tab === "batch" ? "batch" : "document"
  const currentRef = useRef<HTMLButtonElement>(null)

  const groups = useMemo(() => {
    const byPlace = new Map<string, ListedHit[]>()
    for (const hit of search.list) {
      const key = hit.worksheet ?? `page-${hit.page}`
      byPlace.set(key, [...(byPlace.get(key) ?? []), hit])
    }
    return [...byPlace.values()]
  }, [search.list])

  const position = search.current
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" })
  }, [position])

  return (
    <Wrapper variant={variant}>
      <div className="flex items-center gap-1 border-b border-border px-2 pt-2">
        <PanelTab selected={active === "document"} onClick={() => setTab("document")}>
          This document
          {search.status === "ready" ? (
            <span className="text-text-muted"> {search.total.toLocaleString("en")}</span>
          ) : null}
        </PanelTab>
        {inBatch && search.batch.open ? (
          <PanelTab selected={active === "batch"} onClick={() => setTab("batch")}>
            This batch
          </PanelTab>
        ) : null}
        <button
          type="button"
          onClick={() => {
            dispatch(resultsToggled(false))
            if (search.batch.open) dispatch(batchSearchToggled(false))
          }}
          hidden={variant === "sheet"}
          className="mb-1.5 ml-auto rounded p-1 text-text-muted transition-colors hover:bg-white/6 hover:text-white"
          title="Hide results"
        >
          <X className="size-3.5" />
          <span className="sr-only">Hide results</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {active === "batch" ? (
          <BatchResults />
        ) : search.total === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-muted">
            Nothing in this document matches. Check the spelling, or turn off
            match case and whole word.
          </p>
        ) : (
          <>
            {groups.map((hits) => (
              <section key={where(hits[0])} className="pb-2">
                <h3 className="sticky top-0 z-10 flex items-center justify-between bg-surface-2 px-2 py-1 text-[11px] font-medium tracking-wide text-text-muted uppercase">
                  <span>{where(hits[0])}</span>
                  <span className="tabular-nums normal-case">
                    {search.pages.find((entry) => entry.page === hits[0].page)?.count ??
                      hits.length}
                  </span>
                </h3>
                <ul>
                  {hits.map((hit) => {
                    const current = hit.index === search.current
                    return (
                      <li key={hit.index}>
                        <button
                          ref={current ? currentRef : undefined}
                          type="button"
                          aria-current={current ? "true" : undefined}
                          onClick={() => dispatch(currentChanged(hit.index))}
                          className={cn(
                            "w-full rounded-md border-l-2 px-2 py-1.5 text-left text-xs leading-relaxed transition-colors pointer-coarse:min-h-11 pointer-coarse:py-2.5",
                            current
                              ? "border-search-current bg-white/6 text-white"
                              : "border-transparent text-text-secondary hover:bg-white/4"
                          )}
                        >
                          <span className="text-text-muted">{hit.before}</span>
                          <mark className="rounded-[2px] bg-search-hit px-0.5 text-white">
                            {hit.match}
                          </mark>
                          <span className="text-text-muted">{hit.after}</span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
            {search.total > search.list.length ? (
              <p className="px-2 pt-1 pb-2 text-[11px] text-text-muted">
                Showing the first {search.list.length.toLocaleString("en")} of{" "}
                {search.total.toLocaleString("en")}. Next and previous reach
                every one.
              </p>
            ) : null}
          </>
        )}
      </div>
    </Wrapper>
  )
}

function Wrapper({
  variant,
  children,
}: {
  variant: "column" | "sheet"
  children: ReactNode
}) {
  if (variant === "sheet") {
    return <div className="flex min-h-0 flex-1 flex-col">{children}</div>
  }
  return (
    <aside
      aria-label="Search results"
      className="flex w-[320px] shrink-0 flex-col border-l border-border bg-surface-2"
    >
      {children}
    </aside>
  )
}

function PanelTab({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "-mb-px border-b-2 px-2 pb-2 text-xs transition-colors pointer-coarse:min-h-11",
        selected ? "border-primary text-white" : "border-transparent text-text-muted hover:text-white"
      )}
    >
      {children}
    </button>
  )
}

function BatchResults() {
  const batch = useAppSelector((state) => state.search.batch)
  const currentId = useAppSelector((state) => state.document.summary?.id)

  if (batch.status === "searching") {
    return (
      <p className="flex items-center gap-2 px-2 py-4 text-xs text-text-muted">
        <Loader2 className="size-3.5 animate-spin" /> Searching every document…
      </p>
    )
  }
  if (batch.status === "error") {
    return <p className="px-2 py-4 text-xs text-primary">{batch.error}</p>
  }

  return (
    <ul className="flex flex-col">
      {batch.documents.map((document) => (
        <li key={document.id}>
          <Link
            href={`/workspace/${document.id}`}
            aria-current={document.id === currentId ? "page" : undefined}
            className={cn(
              "flex items-center justify-between gap-3 rounded-md px-2 py-2 text-xs transition-colors hover:bg-white/5",
              document.id === currentId ? "text-white" : "text-text-secondary"
            )}
          >
            <span className="truncate">{document.name}</span>
            <span
              className={cn(
                "shrink-0 tabular-nums",
                document.count ? "rounded-full bg-search-hit px-2 text-white" : "text-text-muted"
              )}
            >
              {document.count === null
                ? (document.note ?? "—")
                : document.count === 1
                  ? "1 match"
                  : `${document.count.toLocaleString("en")} matches`}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  )
}
