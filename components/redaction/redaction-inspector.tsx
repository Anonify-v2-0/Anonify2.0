"use client"

import { useMemo } from "react"
import { Check, Globe, Sparkles, User, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { filtersChanged, redactionSelected } from "@/store/redactionSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import {
  selectCategories,
  selectCounts,
  selectOccurrenceGroups,
} from "@/store/selectors"
import { confidenceBand, type RedactionSource } from "@/types/redaction"

/**
 * The redaction inspector.
 *
 * Suggestions are grouped by the value they cover, because that is the decision
 * a reviewer is actually making: one call about "John Smith", not seventeen.
 * Confidence is shown as a band and a percentage, never as a verdict — the
 * accept and ignore buttons are the only things that change the document.
 */

const SOURCE_FILTERS: { label: string; value: RedactionSource | "all" }[] = [
  { label: "All", value: "all" },
  { label: "AI", value: "ai" },
  { label: "Manual", value: "user" },
  { label: "Rules", value: "rule" },
]

const BAND_STYLES = {
  high: "text-white",
  medium: "text-text-secondary",
  low: "text-text-muted",
} as const

export type InspectorActions = {
  accept: (ids: string[]) => void
  reject: (ids: string[]) => void
  applyGlobalRule: (pattern: string, category: string) => void
}

/** Desktop rail. The same body is reused by the mobile sheet below. */
export function RedactionInspector({ actions }: { actions?: InspectorActions }) {
  return (
    <aside className="hidden w-[320px] shrink-0 flex-col border-l border-border bg-surface-2 xl:flex">
      <InspectorBody actions={actions} />
    </aside>
  )
}

export function InspectorBody({ actions }: { actions?: InspectorActions }) {
  const dispatch = useAppDispatch()
  const groups = useAppSelector(selectOccurrenceGroups)
  const counts = useAppSelector(selectCounts)
  const categories = useAppSelector(selectCategories)
  const filters = useAppSelector((state) => state.redactions.filters)
  const selectedId = useAppSelector((state) => state.redactions.selectedId)

  const allIds = useMemo(
    () => groups.flatMap((group) => group.members.map((member) => member.id)),
    [groups]
  )

  return (
    <>
      <div className="flex items-baseline justify-between px-4 pt-4">
        <p className="label-micro">Redactions</p>
        <span className="text-xs text-text-muted">
          {counts.accepted} of {counts.total} accepted
        </span>
      </div>

      <div className="flex flex-wrap gap-1 px-4 pt-3">
        {SOURCE_FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            onClick={() => dispatch(filtersChanged({ source: filter.value }))}
            className={cn(
              "rounded-full px-2.5 py-1 text-[11px] transition-colors",
              filters.source === filter.value
                ? "bg-red-soft text-primary"
                : "text-text-muted hover:text-white"
            )}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {categories.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-4 pt-2">
          <button
            type="button"
            onClick={() => dispatch(filtersChanged({ category: "all" }))}
            className={cn(
              "rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase transition-colors",
              filters.category === "all"
                ? "border-red-border text-primary"
                : "border-border text-text-muted hover:text-white"
            )}
          >
            All types
          </button>
          {categories.slice(0, 8).map(({ category, count }) => (
            <button
              key={category}
              type="button"
              onClick={() => dispatch(filtersChanged({ category }))}
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] tracking-wide uppercase transition-colors",
                filters.category === category
                  ? "border-red-border text-primary"
                  : "border-border text-text-muted hover:text-white"
              )}
            >
              {category} {count}
            </button>
          ))}
        </div>
      ) : null}

      {actions && allIds.length > 0 ? (
        <div className="flex gap-2 px-4 py-3">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => actions.accept(allIds)}
          >
            Accept all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="flex-1"
            onClick={() => actions.reject(allIds)}
          >
            Reject all
          </Button>
        </div>
      ) : null}

      <ScrollArea className="flex-1">
        <ul
          aria-label="Redaction suggestions"
          className="flex flex-col gap-px px-4 pb-6"
        >
          {groups.length === 0 ? (
            <li className="pt-4 text-xs leading-relaxed text-text-muted">
              No suggestions match this filter. Select text in the document, or
              drag a region, to redact something by hand.
            </li>
          ) : null}

          {groups.map((group) => {
            const first = group.members[0]
            const band = confidenceBand(first.confidence)
            const accepted = group.members.filter(
              (member) => member.status === "accepted"
            ).length
            const isSelected = group.members.some(
              (member) => member.id === selectedId
            )

            const accessibleName = `${group.category}: ${group.text}. ${
              group.members.length
            } ${group.members.length === 1 ? "occurrence" : "occurrences"}${
              first.confidence !== undefined
                ? `, ${Math.round(first.confidence * 100)} percent confidence`
                : ""
            }${accepted > 0 ? `, ${accepted} accepted` : ""}.`

            return (
              <li
                key={group.key}
                className={cn(
                  "-mx-2 rounded-md border-b border-border/60 px-2 py-3 transition-colors last:border-b-0",
                  isSelected ? "bg-red-soft" : "hover:bg-white/3"
                )}
              >
                {/*
                  The row itself is the button, so the whole suggestion is one
                  tab stop and one announcement rather than a div a pointer can
                  click and a keyboard cannot reach.
                */}
                <button
                  type="button"
                  aria-label={accessibleName}
                  aria-current={isSelected ? "true" : undefined}
                  onClick={() => dispatch(redactionSelected(first.id))}
                  className="block w-full text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="label-micro">{group.category}</span>
                    <span className={cn("text-[11px]", BAND_STYLES[band])}>
                      {first.confidence !== undefined
                        ? `${Math.round(first.confidence * 100)}%`
                        : "manual"}
                    </span>
                  </span>

                  <span
                    className="mt-1 block truncate text-sm text-white"
                    title={group.text}
                  >
                    {group.text}
                  </span>
                </button>

                <div aria-hidden className="mt-1 flex items-center gap-2 text-[11px] text-text-muted">
                  {first.source === "ai" ? (
                    <Sparkles className="size-3" />
                  ) : first.source === "rule" ? (
                    <Globe className="size-3" />
                  ) : (
                    <User className="size-3" />
                  )}
                  <span>
                    {group.members.length === 1
                      ? "1 occurrence"
                      : `${group.members.length} occurrences`}
                  </span>
                  {accepted > 0 ? (
                    <span className="text-primary">
                      · {accepted} accepted
                    </span>
                  ) : null}
                </div>

                {first.reason ? (
                  <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
                    {first.reason}
                  </p>
                ) : null}

                {actions ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`Redact ${group.text}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        actions.accept([first.id])
                      }}
                    >
                      <Check className="size-3" />
                      Redact this
                    </Button>
                    {group.members.length > 1 ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={(event) => {
                          event.stopPropagation()
                          actions.accept(
                            group.members.map((member) => member.id)
                          )
                        }}
                      >
                        Redact all {group.members.length}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation()
                          actions.applyGlobalRule(group.text, group.category)
                        }}
                      >
                        <Globe className="size-3" />
                        Everywhere
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Ignore ${group.text}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        actions.reject(group.members.map((member) => member.id))
                      }}
                    >
                      <X className="size-3" />
                      Ignore
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </ScrollArea>
    </>
  )
}
