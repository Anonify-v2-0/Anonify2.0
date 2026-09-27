"use client"

import { useEffect, useRef, type ReactNode } from "react"
import Link from "next/link"
import {
  CaseSensitive,
  ChevronDown,
  ChevronUp,
  Layers,
  ListChecks,
  Regex,
  Search,
  SquareDashed,
  WholeWord,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { shortcutHint } from "@/lib/editor/shortcuts"
import { cn } from "@/lib/utils"
import { useAppDispatch, useAppSelector, useAppStore } from "@/store/hooks"
import {
  batchSearchToggled,
  describeSearch,
  optionsChanged,
  queryChanged,
  searchClosed,
  selectCurrentHit,
  specOfSearch,
} from "@/store/searchSlice"
import { ruleDialogOpened } from "@/store/uiSlice"
import type { Redaction } from "@/types/redaction"

/**
 * The search bar over the canvas.
 *
 * It replaces the browser's find on this screen: that find cannot read a PDF
 * page, which is text drawn on a canvas, and it cannot see pages that are not
 * loaded — so on the one screen where "not found" matters most, it would say
 * it with confidence and be wrong.
 *
 * From here a hit becomes a decision in one step: "Redact this" makes the
 * current hit a manual redaction; "Redact all" opens the rule dialog with the
 * search already filled in, where the reviewer sees every match before
 * anything is written.
 */

function Toggle({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed: boolean
  label: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-pressed={pressed}
            onClick={onClick}
            className={cn(pressed && "bg-red-soft text-primary")}
          >
            {children}
            <span className="sr-only">{label}</span>
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
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

  const status = describeSearch(search)
  const ready = search.status === "ready" && search.total > 0

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

  const currentLoaded =
    hit?.kind === "cell" ||
    (hit?.kind === "page" &&
      search.pageHits[hit.page]?.[hit.index] !== undefined)

  return (
    <div
      role="search"
      aria-label="Search this document"
      className="absolute top-3 right-3 left-3 z-20 flex flex-col gap-2 sm:left-auto sm:w-[460px]"
    >
      <div className="panel flex flex-col gap-1.5 p-2 shadow-panel">
        <div className="flex items-center gap-1">
          <Search
            aria-hidden
            className="ml-1 size-4 shrink-0 text-text-muted"
          />
          <input
            ref={inputRef}
            type="search"
            value={search.query}
            placeholder={
              search.regex
                ? "RegEx, e.g. EMP-\\d{5}"
                : "Search the whole document"
            }
            aria-label="Search the whole document"
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
            className="h-8 min-w-0 flex-1 bg-transparent px-1 text-sm text-white outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
          />
          <Toggle
            pressed={search.matchCase}
            label="Match case"
            onClick={() =>
              dispatch(optionsChanged({ matchCase: !search.matchCase }))
            }
          >
            <CaseSensitive className="size-3.5" />
          </Toggle>
          <Toggle
            pressed={search.wholeWord}
            label="Whole word"
            onClick={() =>
              dispatch(optionsChanged({ wholeWord: !search.wholeWord }))
            }
          >
            <WholeWord className="size-3.5" />
          </Toggle>
          <Toggle
            pressed={search.regex}
            label="Regular expression (RE2)"
            onClick={() => dispatch(optionsChanged({ regex: !search.regex }))}
          >
            <Regex className="size-3.5" />
          </Toggle>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={close}
                >
                  <X className="size-3.5" />
                  <span className="sr-only">Close search</span>
                </Button>
              }
            />
            <TooltipContent>
              Close search ({shortcutHint("search-close")})
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="flex flex-wrap items-center gap-1 border-t border-border pt-1.5">
          <span
            id="search-status"
            className={cn(
              "mr-auto pl-1 text-xs tabular-nums",
              search.status === "error" ? "text-primary" : "text-text-muted"
            )}
          >
            {status || "Type to search every page"}
          </span>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!ready}
                  onClick={onPrevious}
                >
                  <ChevronUp className="size-3.5" />
                  <span className="sr-only">Previous match</span>
                </Button>
              }
            />
            <TooltipContent>
              Previous match ({shortcutHint("search-previous")})
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!ready}
                  onClick={onNext}
                >
                  <ChevronDown className="size-3.5" />
                  <span className="sr-only">Next match</span>
                </Button>
              }
            />
            <TooltipContent>
              Next match ({shortcutHint("search-next")})
            </TooltipContent>
          </Tooltip>

          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!ready || !currentLoaded}
            onClick={redactCurrent}
          >
            <SquareDashed className="size-3" />
            Redact this
          </Button>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={!ready}
            onClick={redactAll}
          >
            <ListChecks className="size-3" />
            Redact all{ready ? ` ${search.total.toLocaleString("en")}` : ""}
          </Button>
          {inBatch && batchId ? (
            <Toggle
              pressed={search.batch.open}
              label="Search this batch"
              onClick={() => dispatch(batchSearchToggled())}
            >
              <Layers className="size-3.5" />
            </Toggle>
          ) : null}
        </div>
      </div>

      {search.batch.open && inBatch && search.query ? <BatchResults /> : null}
    </div>
  )
}

function BatchResults() {
  const batch = useAppSelector((state) => state.search.batch)
  const currentId = useAppSelector((state) => state.document.summary?.id)

  return (
    <div className="panel max-h-64 overflow-auto p-2 shadow-panel">
      <p className="label-micro px-1 pb-1">In this batch</p>
      {batch.status === "searching" ? (
        <p className="px-1 py-1 text-xs text-text-muted">
          Searching every document…
        </p>
      ) : batch.status === "error" ? (
        <p className="px-1 py-1 text-xs text-primary">{batch.error}</p>
      ) : (
        <ul className="flex flex-col">
          {batch.documents.map((document) => (
            <li key={document.id}>
              <Link
                href={`/workspace/${document.id}`}
                aria-current={document.id === currentId ? "page" : undefined}
                className={cn(
                  "flex items-center justify-between gap-2 rounded px-1 py-1 text-xs hover:bg-white/5",
                  document.id === currentId
                    ? "text-white"
                    : "text-text-secondary"
                )}
              >
                <span className="truncate">{document.name}</span>
                <span className="shrink-0 text-text-muted tabular-nums">
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
      )}
    </div>
  )
}
