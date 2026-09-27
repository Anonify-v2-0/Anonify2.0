"use client"

import { useEffect, useState, type ReactNode } from "react"
import {
  BookOpenText,
  Check,
  ChevronRight,
  CircleSlash,
  Eye,
  FileSearch,
  Files,
  ListChecks,
  Loader2,
  ScanSearch,
  Scale,
  ShieldCheck,
  SquareDashed,
  Wand2,
  X,
} from "lucide-react"

import { MatchSamples } from "@/components/rules/match-samples"
import { Button } from "@/components/ui/button"
import type { HushUIMessage } from "@/lib/assistant/agent"
import { parseReference } from "@/lib/assistant/references"
import { suggestionKeyOf } from "@/lib/assistant/keys"
import type { PatternSpec } from "@/lib/redaction/patterns"
import type { MatchPreview, MatchSample } from "@/lib/redaction/search"
import { cn } from "@/lib/utils"
import { focusRequested } from "@/store/editorSlice"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { searchSet } from "@/store/searchSlice"
import { selectRedactions } from "@/store/selectors"

/**
 * One tool call in a Hush conversation, drawn for the reviewer.
 *
 * Reads are a line of activity — what Hush looked at and what it found — that
 * opens into the result: the occurrences with where they are and whether
 * they are covered, the groups the detectors found, the preview of a rule.
 * Every location is a button that takes the canvas there.
 *
 * Changes are approval cards. Each says in plain words what will happen,
 * shows the evidence (a rule's matches, the exact values to redact, the
 * groups to accept), and waits. Nothing on a card has happened until the
 * reviewer presses Approve; after that the card says what did.
 */

type Part = Extract<HushUIMessage["parts"][number], { toolCallId: string }>

export type ApprovalHandlers = {
  approve: (part: Part) => void
  deny: (part: Part) => void
}

const scopeLabel: Record<string, string> = {
  document: "This document",
  batch: "Whole batch",
  global: "All my uploads",
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString("en")} ${count === 1 ? one : many}`
}

function specName(spec: Pick<PatternSpec, "kind" | "pattern">): string {
  return spec.kind === "regex" ? `/${spec.pattern}/` : `“${spec.pattern}”`
}

// --- the activity line for reads ---------------------------------------------

function Activity({
  icon,
  running,
  label,
  detail,
  error,
  children,
}: {
  icon: ReactNode
  running: boolean
  label: ReactNode
  detail?: ReactNode
  error?: string
  children?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(children) && !running && !error

  return (
    <div className="rounded-md border border-border/70 bg-surface-3/50">
      <button
        type="button"
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs disabled:cursor-default"
      >
        <span aria-hidden className="text-text-muted">
          {running ? <Loader2 className="size-3.5 animate-spin" /> : icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-text-secondary">
          {label}
          {detail ? <span className="text-text-muted"> · {detail}</span> : null}
        </span>
        {expandable ? (
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3.5 text-text-muted transition-transform",
              open && "rotate-90"
            )}
          />
        ) : null}
      </button>
      {error ? (
        <p className="px-2.5 pb-2 text-xs text-primary">{error}</p>
      ) : null}
      {open && children ? (
        <div className="border-t border-border/70 px-2.5 py-2">{children}</div>
      ) : null}
    </div>
  )
}

/**
 * A place in a tool result, as a button that takes the canvas there: the page
 * or sheet changes, the place scrolls into view and is marked for a moment.
 */
function Locate({ reference, children }: { reference: string; children: ReactNode }) {
  const dispatch = useAppDispatch()
  const sheets = useAppSelector((state) => state.document.normalized?.sheets)
  const ref = parseReference(reference)
  return (
    <button
      type="button"
      title="Show this in the document"
      onClick={() => {
        if (!ref) return
        if (ref.kind === "text") {
          dispatch(focusRequested({ kind: "text", page: ref.page, start: ref.start, end: ref.end }))
        } else if (sheets?.[ref.sheet]) {
          dispatch(
            focusRequested({
              kind: "cell",
              sheet: sheets[ref.sheet].name,
              row: ref.row,
              column: ref.column,
            })
          )
        }
      }}
      className="shrink-0 rounded bg-white/6 px-1.5 py-0.5 font-mono text-[10px] text-text-secondary transition-colors hover:bg-white/12 hover:text-white"
    >
      {children}
    </button>
  )
}

function CoverageBadge({ covered }: { covered: string | null }) {
  const label =
    covered === "accepted"
      ? "redacted"
      : covered === "suggested"
        ? "suggested"
        : covered === "partial"
          ? "partly covered"
          : covered === "rejected"
            ? "kept in file"
            : "not covered"
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-px text-[10px]",
        covered === "accepted"
          ? "bg-white/8 text-text-muted"
          : covered === "suggested"
            ? "bg-red-soft text-primary"
            : "bg-search-hit text-white"
      )}
    >
      {label}
    </span>
  )
}

function errorOf(output: unknown): string | undefined {
  return output && typeof output === "object" && "error" in output
    ? String((output as { error: unknown }).error)
    : undefined
}

// --- reads --------------------------------------------------------------------

function ReadPart({ part }: { part: Part }) {
  const dispatch = useAppDispatch()
  const running =
    part.state === "input-streaming" || part.state === "input-available"
  const output = part.state === "output-available" ? part.output : undefined
  const failure =
    part.state === "output-error" ? part.errorText : errorOf(output)

  switch (part.type) {
    case "tool-get_document_overview": {
      const result = output as
        { pages?: number; redactions?: { total: number } } | undefined
      return (
        <Activity
          icon={<Files className="size-3.5" />}
          running={running}
          label="Looked at the document"
          detail={
            result && !failure
              ? `${plural(result.pages ?? 0, "page")}, ${plural(result.redactions?.total ?? 0, "redaction")}`
              : undefined
          }
          error={failure}
        />
      )
    }
    case "tool-read_page": {
      const input = part.input as { page?: number } | undefined
      return (
        <Activity
          icon={<BookOpenText className="size-3.5" />}
          running={running}
          label={`Read page ${input?.page ?? "…"}`}
          error={failure}
        />
      )
    }
    case "tool-read_sheet": {
      const result = output as { sheet?: string; cells?: unknown[] } | undefined
      return (
        <Activity
          icon={<BookOpenText className="size-3.5" />}
          running={running}
          label={`Read ${result?.sheet ?? "a sheet"}`}
          detail={
            result?.cells ? plural(result.cells.length, "cell") : undefined
          }
          error={failure}
        />
      )
    }
    case "tool-find_occurrences": {
      const input = part.input as Partial<PatternSpec> | undefined
      const result = output as
        | {
            spec: PatternSpec
            total: number
            uncovered: number
            byPage: Record<string, number>
            truncated: boolean
            occurrences: {
              ref: string
              page?: number
              sheet?: string
              text: string
              before?: string
              after?: string
              covered: string | null
            }[]
          }
        | undefined
      const pages = result ? Object.keys(result.byPage).length : 0
      return (
        <Activity
          icon={<FileSearch className="size-3.5" />}
          running={running}
          label={
            <>
              Found{" "}
              <code className="text-white">
                {input?.pattern ? specName(input as PatternSpec) : "…"}
              </code>
            </>
          }
          detail={
            result && !failure
              ? `${plural(result.total, "time")}${pages ? ` on ${plural(pages, "page")}` : ""}, ${result.uncovered} not covered`
              : undefined
          }
          error={failure}
        >
          {result && !failure ? (
            <div className="flex flex-col gap-1">
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {result.occurrences.map((occurrence) => (
                  <li
                    key={occurrence.ref}
                    className="flex items-baseline gap-2 text-[11px]"
                  >
                    <Locate reference={occurrence.ref}>
                      {occurrence.page
                        ? `p.${occurrence.page}`
                        : occurrence.sheet}
                    </Locate>
                    <span className="min-w-0 flex-1 break-words text-text-muted">
                      {occurrence.before}
                      <mark className="rounded-[2px] bg-search-hit px-0.5 text-white">
                        {occurrence.text}
                      </mark>
                      {occurrence.after}
                    </span>
                    <CoverageBadge covered={occurrence.covered} />
                  </li>
                ))}
              </ul>
              {result.truncated ? (
                <p className="text-[11px] text-text-muted">
                  Showing {result.occurrences.length} of {result.total}.
                </p>
              ) : null}
              <Button
                size="xs"
                variant="ghost"
                className="self-start"
                onClick={() => dispatch(searchSet(result.spec))}
              >
                <Eye className="size-3" /> Show all in the document
              </Button>
            </div>
          ) : null}
        </Activity>
      )
    }
    case "tool-find_uncovered": {
      const result = output as
        | {
            totalGroups: number
            groups: {
              category: string
              value: string
              occurrences: number
              pages: number[]
              refs: string[]
            }[]
          }
        | undefined
      return (
        <Activity
          icon={<ScanSearch className="size-3.5" />}
          running={running}
          label="Scanned for anything not yet redacted"
          detail={
            result && !failure
              ? result.totalGroups === 0
                ? "nothing found"
                : plural(result.totalGroups, "value")
              : undefined
          }
          error={failure}
        >
          {result && result.groups.length > 0 ? (
            <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
              {result.groups.map((group) => (
                <li
                  key={`${group.category}|${group.value}`}
                  className="flex items-baseline gap-2 text-[11px]"
                >
                  <span className="w-20 shrink-0 truncate tracking-wide text-text-muted uppercase">
                    {group.category}
                  </span>
                  <code className="min-w-0 flex-1 truncate text-white">
                    {group.value}
                  </code>
                  <span className="flex shrink-0 gap-1">
                    {group.refs.slice(0, 3).map((ref) => (
                      <Locate key={ref} reference={ref}>
                        {parseReference(ref)?.kind === "text"
                          ? `p.${(parseReference(ref) as { page: number }).page}`
                          : "cell"}
                      </Locate>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Activity>
      )
    }
    case "tool-list_suggestions": {
      const result = output as
        | {
            totalGroups: number
            groups: {
              key: string
              text: string
              category: string
              count: number
            }[]
          }
        | undefined
      return (
        <Activity
          icon={<ListChecks className="size-3.5" />}
          running={running}
          label="Looked at the suggestions"
          detail={
            result && !failure ? plural(result.totalGroups, "group") : undefined
          }
          error={failure}
        >
          {result && result.groups.length > 0 ? (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto text-[11px]">
              {result.groups.map((group) => (
                <li key={group.key} className="flex items-baseline gap-2">
                  <span className="w-20 shrink-0 truncate tracking-wide text-text-muted uppercase">
                    {group.category}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-white">
                    {group.text}
                  </span>
                  <span className="shrink-0 text-text-muted tabular-nums">
                    ×{group.count}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </Activity>
      )
    }
    case "tool-list_rules": {
      const result = output as { rules?: unknown[] } | undefined
      return (
        <Activity
          icon={<ListChecks className="size-3.5" />}
          running={running}
          label="Looked at the rules"
          detail={
            result?.rules ? plural(result.rules.length, "rule") : undefined
          }
          error={failure}
        />
      )
    }
    case "tool-preview_rule": {
      const input = part.input as Partial<PatternSpec> | undefined
      const result = output as MatchPreview | undefined
      return (
        <Activity
          icon={<Eye className="size-3.5" />}
          running={running}
          label={
            <>
              Previewed{" "}
              <code className="text-white">
                {input?.pattern ? specName(input as PatternSpec) : "…"}
              </code>
            </>
          }
          detail={
            result && !failure
              ? plural(result.count, "match", "matches")
              : undefined
          }
          error={failure}
        >
          {result && !failure ? (
            <MatchSamples samples={result.samples} label="Preview matches" />
          ) : null}
        </Activity>
      )
    }
    case "tool-compare_patterns": {
      const result = output as
        | {
            gainedCount: number
            lostCount: number
            gained: MatchSample[]
            lost: MatchSample[]
          }
        | undefined
      return (
        <Activity
          icon={<Scale className="size-3.5" />}
          running={running}
          label="Compared two patterns"
          detail={
            result && !failure
              ? `gains ${result.gainedCount}, loses ${result.lostCount}`
              : undefined
          }
          error={failure}
        >
          {result && !failure ? (
            <div className="flex flex-col gap-2">
              {result.gained.length ? (
                <MatchSamples
                  samples={result.gained}
                  tone="gained"
                  label="Would start matching"
                />
              ) : null}
              {result.lost.length ? (
                <MatchSamples
                  samples={result.lost}
                  tone="lost"
                  label="Would stop matching"
                />
              ) : null}
            </div>
          ) : null}
        </Activity>
      )
    }
    default:
      return null
  }
}

// --- the consent card ------------------------------------------------------

function ConsentCard({
  part,
  handlers,
}: {
  part: Part
  handlers: ApprovalHandlers
}) {
  const name = useAppSelector((state) => state.document.summary?.originalName)
  return (
    <div className="rounded-lg border border-border-strong bg-surface-3 p-3">
      <p className="flex items-center gap-2 text-sm font-medium text-white">
        <ShieldCheck className="size-4 text-text-secondary" />
        Let Hush read this document?
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-text-muted">
        To answer, Hush reads{" "}
        {name ? (
          <span className="text-text-secondary">{name}</span>
        ) : (
          "this document"
        )}{" "}
        through its tools and sends what it reads to this instance&apos;s AI
        provider — the same provider that analysed it. Every read is listed here
        as it happens. You can switch this off from the header.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => handlers.approve(part)}>
          Allow reading
        </Button>
        <Button size="sm" variant="ghost" onClick={() => handlers.deny(part)}>
          Not now
        </Button>
      </div>
    </div>
  )
}

// --- changes: approval cards ------------------------------------------------

/** A rule's matches, fetched for the approval card, so it is judged on evidence. */
function RulePreview({ spec, scope }: { spec: PatternSpec; scope: string }) {
  const documentId = useAppSelector((state) => state.document.summary?.id)
  const [preview, setPreview] = useState<
    | { state: "loading" }
    | { state: "error"; message: string }
    | {
        state: "ready"
        here: MatchPreview
        batch?: {
          total: number
          documents: { id: string; name: string; count: number | null }[]
        }
      }
  >({ state: "loading" })
  const key = JSON.stringify([spec, scope])

  useEffect(() => {
    if (!documentId) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch(
          `/api/documents/${documentId}/rules/preview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spec, scope }),
            signal: controller.signal,
          }
        )
        const payload = await response.json()
        setPreview(
          response.ok
            ? { state: "ready", ...payload }
            : {
                state: "error",
                message: payload.error ?? "Could not preview this rule.",
              }
        )
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setPreview({
            state: "error",
            message: "Could not preview this rule.",
          })
        }
      }
    })()
    return () => controller.abort()
    // `key` is the identity of spec and scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, key])

  if (preview.state === "loading") {
    return (
      <p className="flex items-center gap-2 text-xs text-text-muted">
        <Loader2 className="size-3 animate-spin" /> Previewing matches…
      </p>
    )
  }
  if (preview.state === "error")
    return <p className="text-xs text-primary">{preview.message}</p>
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-white">
        {plural(preview.here.count, "match", "matches")} in this document
        {preview.batch
          ? `, ${preview.batch.total.toLocaleString("en")} across the batch`
          : ""}
        {scope === "global"
          ? ", and every document you upload from now on"
          : ""}
      </p>
      <MatchSamples
        samples={preview.here.samples.slice(0, 5)}
        label="Matches"
      />
    </div>
  )
}

function ChangeBody({ part }: { part: Part }) {
  const rules = useAppSelector((state) => state.rules.items)
  const redactions = useAppSelector(selectRedactions)

  switch (part.type) {
    case "tool-create_rule": {
      const input = part.input as PatternSpec & {
        category: string
        scope: string
        reason: string
      }
      return (
        <>
          <Title icon={<Wand2 className="size-4" />}>
            Create a rule · {scopeLabel[input.scope] ?? input.scope}
          </Title>
          <p className="font-mono text-xs break-all text-white">
            {specName(input)}
          </p>
          <Meta>
            {input.category}
            {input.matchCase ? " · match case" : ""}
            {input.wholeWord ? " · whole word" : ""}
          </Meta>
          <Reason>{input.reason}</Reason>
          {part.state === "approval-requested" ? (
            <RulePreview spec={input} scope={input.scope} />
          ) : null}
        </>
      )
    }
    case "tool-update_rule": {
      const input = part.input as {
        ruleId: string
        scope: string
        enabled?: boolean
        spec?: PatternSpec
        category?: string
        reason: string
      }
      const rule = rules.find((candidate) => candidate.id === input.ruleId)
      const verb =
        input.enabled === false
          ? "Switch off"
          : input.enabled === true && !input.spec
            ? "Switch on"
            : "Change"
      return (
        <>
          <Title icon={<Wand2 className="size-4" />}>
            {verb} a rule · {scopeLabel[input.scope] ?? input.scope}
          </Title>
          <p className="font-mono text-xs break-all text-white">
            {rule ? specName(rule) : input.ruleId}
            {input.spec ? <span className="text-text-muted"> → </span> : null}
            {input.spec ? specName(input.spec) : null}
          </p>
          {input.category ? <Meta>category → {input.category}</Meta> : null}
          <Reason>{input.reason}</Reason>
          {rule && rule.documents > 1 ? (
            <Meta>
              Changes it in all {rule.documents} documents it reaches.
            </Meta>
          ) : null}
          {part.state === "approval-requested" && input.spec ? (
            <RulePreview spec={input.spec} scope={input.scope} />
          ) : null}
        </>
      )
    }
    case "tool-redact_occurrences": {
      const input = part.input as {
        items: { ref: string; text: string }[]
        category: string
        reason: string
      }
      return (
        <>
          <Title icon={<SquareDashed className="size-4" />}>
            Redact {plural(input.items.length, "value")} as {input.category}
          </Title>
          <Reason>{input.reason}</Reason>
          <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
            {input.items.map((item) => (
              <li
                key={item.ref}
                className="flex items-baseline gap-2 text-[11px]"
              >
                <Locate reference={item.ref}>
                  {(() => {
                    const ref = parseReference(item.ref)
                    return ref?.kind === "text" ? `p.${ref.page}` : "cell"
                  })()}
                </Locate>
                <code className="min-w-0 flex-1 truncate text-white">
                  {item.text}
                </code>
              </li>
            ))}
          </ul>
        </>
      )
    }
    case "tool-set_suggestion_status": {
      const input = part.input as {
        keys: string[]
        status: "accepted" | "rejected"
        reason: string
      }
      const wanted = new Set(input.keys)
      const affected = redactions.filter((redaction) =>
        wanted.has(suggestionKeyOf(redaction))
      )
      const groups = [
        ...new Map(
          affected.map((redaction) => [suggestionKeyOf(redaction), redaction])
        ).values(),
      ]
      return (
        <>
          <Title icon={<ListChecks className="size-4" />}>
            {input.status === "accepted" ? "Accept" : "Reject"}{" "}
            {plural(affected.length, "suggestion")} in{" "}
            {plural(groups.length, "group")}
          </Title>
          <Reason>{input.reason}</Reason>
          <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-[11px]">
            {groups.map((redaction) => (
              <li key={redaction.id} className="flex items-baseline gap-2">
                <span className="w-20 shrink-0 truncate tracking-wide text-text-muted uppercase">
                  {redaction.category}
                </span>
                <span className="min-w-0 flex-1 truncate text-white">
                  {redaction.text}
                </span>
              </li>
            ))}
          </ul>
          {input.status === "rejected" ? (
            <Meta>Rejected values stay in the exported file.</Meta>
          ) : null}
        </>
      )
    }
    default:
      return null
  }
}

function Title({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-sm font-medium text-white">
      <span aria-hidden className="text-primary">
        {icon}
      </span>
      {children}
    </p>
  )
}

function Meta({ children }: { children: ReactNode }) {
  return <p className="text-[11px] tracking-wide text-text-muted">{children}</p>
}

function Reason({ children }: { children: ReactNode }) {
  return children ? (
    <p className="text-xs leading-relaxed text-text-secondary">{children}</p>
  ) : null
}

function outcomeOf(part: Part): string {
  const output =
    part.state === "output-available"
      ? (part.output as Record<string, unknown>)
      : null
  if (!output) return ""
  if ("error" in output) return String(output.error)
  switch (part.type) {
    case "tool-create_rule":
      return `Rule created: ${plural(Number(output.redactions ?? 0), "redaction")}${
        output.documents
          ? ` across ${plural(Number(output.documents), "document")}`
          : " here"
      }.`
    case "tool-update_rule":
      return "Rule updated everywhere it reaches."
    case "tool-redact_occurrences": {
      const refused = (output.refused as unknown[] | undefined)?.length ?? 0
      return `Redacted ${plural(Number(output.redacted ?? 0), "value")}${
        refused ? `; ${refused} no longer matched and were skipped` : ""
      }.`
    }
    case "tool-set_suggestion_status":
      return `${output.status === "accepted" ? "Accepted" : "Rejected"} ${plural(Number(output.updated ?? 0), "suggestion")}.`
    default:
      return "Done."
  }
}

function ChangeCard({
  part,
  handlers,
}: {
  part: Part
  handlers: ApprovalHandlers
}) {
  const waiting = part.state === "approval-requested"
  const denied =
    part.state === "output-denied" ||
    (part.state === "approval-responded" && !part.approval?.approved)
  const running =
    part.state === "input-streaming" ||
    part.state === "input-available" ||
    (part.state === "approval-responded" && part.approval?.approved)
  const failed =
    part.state === "output-error" ||
    (part.state === "output-available" && errorOf(part.output) !== undefined)

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3 transition-colors",
        waiting
          ? "border-red-border bg-red-soft/40"
          : "border-border bg-surface-3/60"
      )}
    >
      {part.state === "input-streaming" ? (
        <p className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="size-3 animate-spin" /> Preparing a change…
        </p>
      ) : (
        <ChangeBody part={part} />
      )}

      {waiting ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" onClick={() => handlers.approve(part)}>
            <Check className="size-3.5" /> Approve
          </Button>
          <Button size="sm" variant="ghost" onClick={() => handlers.deny(part)}>
            <X className="size-3.5" /> Deny
          </Button>
          <span className="text-[11px] text-text-muted">
            Nothing changes until you approve.
          </span>
        </div>
      ) : denied ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <CircleSlash className="size-3.5" /> You declined. Nothing changed.
        </p>
      ) : running ? (
        <p className="flex items-center gap-1.5 text-xs text-text-muted">
          <Loader2 className="size-3.5 animate-spin" /> Applying…
        </p>
      ) : failed ? (
        <p className="text-xs text-primary">
          {part.state === "output-error" ? part.errorText : outcomeOf(part)}
        </p>
      ) : part.state === "output-available" ? (
        <p className="flex items-center gap-1.5 text-xs text-white">
          <Check className="size-3.5 text-primary" /> {outcomeOf(part)}
        </p>
      ) : null}
    </div>
  )
}

const WRITE_PARTS = new Set([
  "tool-create_rule",
  "tool-update_rule",
  "tool-redact_occurrences",
  "tool-set_suggestion_status",
])

export function isChangePart(type: string): boolean {
  return WRITE_PARTS.has(type)
}

export function HushToolPart({
  part,
  handlers,
  askConsent = true,
}: {
  part: Part
  handlers: ApprovalHandlers
  /** False for a read whose consent question another read is already asking. */
  askConsent?: boolean
}) {
  if (isChangePart(part.type))
    return <ChangeCard part={part} handlers={handlers} />
  if (
    part.state === "approval-requested" &&
    part.approval.requestReason === "read-consent"
  ) {
    return askConsent ? <ConsentCard part={part} handlers={handlers} /> : null
  }
  if (
    part.state === "output-denied" ||
    (part.state === "approval-responded" && !part.approval?.approved)
  ) {
    return (
      <p className="flex items-center gap-1.5 px-1 text-xs text-text-muted">
        <CircleSlash className="size-3.5" /> Reading was not allowed.
      </p>
    )
  }
  return <ReadPart part={part} />
}

export type { Part as HushToolUIPart }
