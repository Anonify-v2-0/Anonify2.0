"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Send, Sparkles, X } from "lucide-react"

import { MatchSamples } from "@/components/rules/match-samples"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  learnedRuleRequest,
  suggestedScope,
  useLearnedShapes,
} from "@/hooks/use-learned-shapes"
import { useRules } from "@/hooks/use-rules"
import { readFailure } from "@/lib/api/errors"
import { shortcutHint } from "@/lib/editor/shortcuts"
import type { PatternSpec } from "@/lib/redaction/patterns"
import {
  sampleAround,
  type MatchPreview,
  type MatchSample,
} from "@/lib/redaction/search"
import { cn } from "@/lib/utils"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { selectSelectedRedaction } from "@/store/selectors"
import { searchSet } from "@/store/searchSlice"
import {
  assistantToggled,
  hushOfferDismissed,
  ruleDialogOpened,
} from "@/store/uiSlice"
import type { RuleScope, RuleView } from "@/types/rules"

/**
 * Hush, the review assistant.
 *
 * It helps a reviewer mark what the pipeline missed and turns those decisions
 * into rules — and it only ever proposes. Every proposal arrives with its
 * matches, previewed on the server by the compiler the rule would run under,
 * and becomes a rule only when the reviewer applies it.
 *
 * Three things, in order of how much they need:
 *
 *   learned offers   From the reviewer's own manual redactions, in the
 *                    browser. No model, nothing sent — available everywhere.
 *   ask              A plain-language request to the configured provider.
 *   improve          A RegEx rule tightened against what was accepted and
 *                    rejected, shown as the matches it gains and loses.
 *
 * Before anything is sent, the panel lists exactly what will be. The list is
 * built from the request body itself, so it cannot say one thing while the
 * request carries another.
 */

type Status =
  | { state: "loading" }
  | { state: "ready"; available: true; model: string }
  | { state: "ready"; available: false; reason: string }

const UNAVAILABLE: Record<string, string> = {
  "not-configured":
    "Hush needs an AI provider, and this instance has none configured. An administrator can set one up with `pnpm ai`.",
  unsupported:
    "The configured model cannot return structured answers, which Hush needs. An administrator can choose another with `pnpm ai`.",
  budget:
    "This instance has reached its daily AI spend cap. Hush is back tomorrow (UTC).",
}

const CONTEXT_CHARS = 40
const MAX_SAMPLES = 20

type Proposal = {
  kind: "literal" | "regex"
  pattern: string
  matchCase: boolean
  wholeWord: boolean
  category: string
  scope: RuleScope
  scopeReason: string
  explanation: string
  preview?: MatchPreview
  problem?: string
}

type Improvement = {
  spec: PatternSpec
  explanation: string
  problem?: string
  diff?: {
    before: number
    after: number
    gainedCount: number
    lostCount: number
    gained: MatchSample[]
    lost: MatchSample[]
  }
}

function useHushStatus(open: boolean): Status {
  const [status, setStatus] = useState<Status>({ state: "loading" })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/assistant", { cache: "no-store" })
        const payload = (await response.json()) as
          | { available: true; model: string }
          | { available: false; reason: string }
        if (!cancelled) setStatus({ state: "ready", ...payload })
      } catch {
        if (!cancelled) {
          setStatus({ state: "ready", available: false, reason: "unreachable" })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])
  return status
}

export function HushPanel({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const request = useAppSelector((state) => state.ui.assistant)
  const open = request !== null
  const status = useHushStatus(open)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open)
      panelRef.current?.querySelector<HTMLElement>("textarea, button")?.focus()
  }, [open, request?.mode])

  if (!request) return null

  const available = status.state === "ready" && status.available

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby="hush-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          dispatch(assistantToggled(null))
        }
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-surface-2 shadow-panel sm:w-[400px]"
    >
      <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2
            id="hush-title"
            className="flex items-center gap-2 text-sm font-medium text-white"
          >
            <Sparkles aria-hidden className="size-4 text-primary" />
            Hush
          </h2>
          <p className="mt-0.5 text-[11px] leading-relaxed text-text-muted">
            Proposes rules for what the review missed. Never changes anything on
            its own.
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => dispatch(assistantToggled(null))}
          title={`Close (${shortcutHint("assistant")})`}
        >
          <X className="size-3.5" />
          <span className="sr-only">Close Hush</span>
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-4">
          {status.state === "ready" && !status.available ? (
            <p className="rounded-md border border-border bg-surface-3 p-3 text-xs leading-relaxed text-text-secondary">
              {UNAVAILABLE[status.reason] ??
                "Hush cannot reach this instance's AI provider right now."}{" "}
              Search, shortcuts and rules you write yourself keep working
              without it.
            </p>
          ) : null}

          <LearnedOffers />

          {request.mode === "improve" ? (
            <ImproveRule
              key={request.rule.id}
              documentId={documentId}
              rule={request.rule}
              available={available}
            />
          ) : (
            <Ask documentId={documentId} available={available} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

function LearnedOffers() {
  const dispatch = useAppDispatch()
  const shapes = useLearnedShapes()
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  if (shapes.length === 0) return null

  return (
    <section aria-labelledby="hush-learned" className="flex flex-col gap-2">
      <h3 id="hush-learned" className="label-micro">
        Noticed in your redactions
      </h3>
      {shapes.map((shape) => {
        const { scope, reason } = suggestedScope(inBatch)
        return (
          <div
            key={shape.key}
            className="rounded-md border border-border bg-surface-3/60 p-3"
          >
            <p className="text-xs leading-relaxed text-white">
              You&apos;ve redacted {shape.examples.length} values like{" "}
              <span className="font-mono">{shape.display}</span>. Create a{" "}
              {scope === "batch" ? "batch" : "document"} rule for{" "}
              <code className="font-mono text-primary">
                {shape.spec.pattern}
              </code>
              ?
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">
              {scope === "batch" ? "Batch" : "This document"}, because {reason}
            </p>
            <div className="mt-2 flex gap-1.5">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  dispatch(ruleDialogOpened(learnedRuleRequest(shape, inBatch)))
                }
              >
                Review rule
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => dispatch(hushOfferDismissed(shape.key))}
              >
                Not now
              </Button>
            </div>
          </div>
        )
      })}
    </section>
  )
}

/** What the reviewer can choose to include with a question. */
function useAskContext() {
  const selected = useAppSelector(selectSelectedRedaction)
  const search = useAppSelector((state) => state.search)
  const pages = useAppSelector((state) => state.document.pages)

  const selection = useMemo(() => {
    if (!selected?.text) return null
    const page = selected.page !== undefined ? pages[selected.page] : undefined
    const around =
      page && selected.start !== undefined && selected.end !== undefined
        ? sampleAround(
            page.text,
            { start: selected.start, end: selected.end },
            CONTEXT_CHARS
          )
        : null
    return {
      text: selected.text.slice(0, 500),
      category: selected.category,
      source: selected.source,
      reason: selected.reason?.slice(0, 300),
      before: around?.before,
      after: around?.after,
    }
  }, [pages, selected])

  const matches = useMemo(() => {
    if (!search.open || search.status !== "ready" || search.total === 0)
      return null
    const samples: MatchSample[] = []
    for (const [page, hits] of Object.entries(search.pageHits)) {
      const text = pages[Number(page)]?.text
      if (!text) continue
      for (const hit of hits) {
        if (samples.length >= MAX_SAMPLES) break
        samples.push(sampleAround(text, hit, CONTEXT_CHARS))
      }
    }
    if (samples.length === 0) return null
    return { query: search.query, samples }
  }, [pages, search])

  return { selection, matches }
}

function Ask({
  documentId,
  available,
}: {
  documentId: string
  available: boolean
}) {
  const dispatch = useAppDispatch()
  const { selection, matches } = useAskContext()
  const [question, setQuestion] = useState("")
  const [includeSelection, setIncludeSelection] = useState(true)
  const [includeMatches, setIncludeMatches] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [answer, setAnswer] = useState<{
    answer: string
    proposals: Proposal[]
  } | null>(null)

  // The request body, built once — the "will send" list below reads from it.
  const body = {
    mode: "ask" as const,
    question: question.trim(),
    ...(selection && includeSelection ? { selection } : {}),
    ...(matches && includeMatches ? { matches } : {}),
  }

  async function send() {
    if (!body.question || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${documentId}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError(
          (await readFailure(response, "Hush could not answer.")).message
        )
        return
      }
      setAnswer(
        (await response.json()) as { answer: string; proposals: Proposal[] }
      )
    } catch {
      setError("Hush could not be reached. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="hush-ask" className="flex flex-col gap-3">
      <h3 id="hush-ask" className="label-micro">
        Ask Hush
      </h3>
      <textarea
        value={question}
        disabled={!available}
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void send()
          }
        }}
        rows={3}
        maxLength={1000}
        placeholder="e.g. Find anything that looks like a patient number"
        aria-describedby="hush-sends"
        className="resize-none rounded-md border border-input bg-input/30 px-2.5 py-2 text-sm text-white outline-none placeholder:text-text-muted focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
      />

      {selection || matches ? (
        <fieldset className="flex flex-col gap-1.5 text-xs text-text-secondary">
          <legend className="sr-only">Include with the question</legend>
          {selection ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={includeSelection}
                onChange={(event) => setIncludeSelection(event.target.checked)}
              />
              <span>
                The selected redaction,{" "}
                <span className="font-mono">{selection.text}</span>
              </span>
            </label>
          ) : null}
          {matches ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={includeMatches}
                onChange={(event) => setIncludeMatches(event.target.checked)}
              />
              <span>
                {matches.samples.length} search{" "}
                {matches.samples.length === 1 ? "match" : "matches"} for{" "}
                <span className="font-mono">{matches.query}</span>
              </span>
            </label>
          ) : null}
        </fieldset>
      ) : null}

      <div
        id="hush-sends"
        className="rounded-md bg-surface-3 p-2.5 text-[11px] leading-relaxed text-text-muted"
      >
        <p className="text-text-secondary">Hush will send the AI provider:</p>
        <ul className="mt-1 list-disc pl-4">
          <li>your question</li>
          {"selection" in body && body.selection ? (
            <li>
              the selected value, its category and reason, with up to{" "}
              {CONTEXT_CHARS} characters either side
            </li>
          ) : null}
          {"matches" in body && body.matches ? (
            <li>
              {body.matches.samples.length} search{" "}
              {body.matches.samples.length === 1 ? "match" : "matches"}, each
              with up to {CONTEXT_CHARS} characters either side
            </li>
          ) : null}
        </ul>
        <p className="mt-1">
          Nothing else from the document. The call is counted in this
          document&apos;s AI usage.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2">
        {error ? <p className="mr-auto text-xs text-primary">{error}</p> : null}
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={!available || !body.question || busy}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          Ask
        </Button>
      </div>

      {answer ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="text-sm leading-relaxed text-white">{answer.answer}</p>
          {answer.proposals.map((proposal, index) => (
            <ProposalCard
              key={`${proposal.pattern}-${index}`}
              documentId={documentId}
              proposal={proposal}
              onDismiss={() =>
                setAnswer((current) =>
                  current
                    ? {
                        ...current,
                        proposals: current.proposals.filter(
                          (_, at) => at !== index
                        ),
                      }
                    : current
                )
              }
              onSearch={(spec) => dispatch(searchSet(spec))}
            />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function ProposalCard({
  documentId,
  proposal,
  onDismiss,
  onSearch,
}: {
  documentId: string
  proposal: Proposal
  onDismiss: () => void
  onSearch: (spec: PatternSpec) => void
}) {
  const dispatch = useAppDispatch()
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  const [scope, setScope] = useState<RuleScope>(proposal.scope)
  const [applying, setApplying] = useState(false)
  const [applied, setApplied] = useState(false)
  const { create } = useRules(documentId, false)

  const spec: PatternSpec = {
    kind: proposal.kind,
    pattern: proposal.pattern,
    matchCase: proposal.matchCase,
    wholeWord: proposal.wholeWord,
  }
  const scopes: RuleScope[] = inBatch
    ? ["document", "batch", "global"]
    : ["document", "global"]

  async function apply() {
    // A rule that reaches beyond this document goes through the dialog, which
    // previews the rest of the batch and says what a global rule keeps.
    if (scope !== "document") {
      dispatch(
        ruleDialogOpened({
          mode: "create",
          spec,
          category: proposal.category,
          scope,
          scopeReason: proposal.scopeReason,
        })
      )
      return
    }
    setApplying(true)
    const done = await create({ spec, category: proposal.category, scope })
    setApplying(false)
    if (done) setApplied(true)
  }

  return (
    <article className="rounded-md border border-border bg-surface-3/60 p-3">
      <p className="font-mono text-xs break-all text-white">
        {proposal.kind === "regex"
          ? `/${proposal.pattern}/`
          : `“${proposal.pattern}”`}
      </p>
      <p className="mt-0.5 text-[11px] text-text-muted">
        <span className="tracking-wide uppercase">{proposal.category}</span>
        {proposal.matchCase ? " · match case" : ""}
        {proposal.wholeWord ? " · whole word" : ""}
      </p>
      <p className="mt-1.5 text-xs leading-relaxed text-text-secondary">
        {proposal.explanation}
      </p>

      {proposal.problem ? (
        <p className="mt-2 text-xs text-primary">{proposal.problem}</p>
      ) : proposal.preview ? (
        <div className="mt-2 flex flex-col gap-1.5">
          <p className="text-xs text-white">
            {proposal.preview.count === 0
              ? "No matches in this document."
              : `${proposal.preview.count.toLocaleString("en")} ${
                  proposal.preview.count === 1 ? "match" : "matches"
                } in this document`}
          </p>
          <MatchSamples
            samples={proposal.preview.samples}
            label="Proposed matches"
          />
        </div>
      ) : null}

      <fieldset className="mt-2">
        <legend className="text-[11px] text-text-muted">
          Scope — suggested because {proposal.scopeReason}
        </legend>
        <div role="radiogroup" className="mt-1 flex flex-wrap gap-1">
          {scopes.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={scope === value}
              onClick={() => setScope(value)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                scope === value
                  ? "bg-red-soft text-primary"
                  : "text-text-muted hover:text-white"
              )}
            >
              {value === "document"
                ? "This document"
                : value === "batch"
                  ? "Whole batch"
                  : "All my uploads"}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {applied ? (
          <p className="text-xs text-primary">Applied.</p>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={Boolean(proposal.problem) || applying}
            onClick={() => void apply()}
          >
            {applying ? <Loader2 className="size-3 animate-spin" /> : null}
            {scope === "document" ? "Apply rule" : "Review and apply"}
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={Boolean(proposal.problem)}
          onClick={() => onSearch(spec)}
        >
          Show in document
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </article>
  )
}

function ImproveRule({
  documentId,
  rule,
  available,
}: {
  documentId: string
  rule: RuleView
  available: boolean
}) {
  const dispatch = useAppDispatch()
  const redactions = useAppSelector((state) => state.redactions.entities)
  const { update } = useRules(documentId, false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Improvement | null>(null)

  const { accepted, rejected } = useMemo(() => {
    const mine = Object.values(redactions).filter(
      (redaction) =>
        rule.copyId !== null &&
        redaction.ruleId === rule.copyId &&
        redaction.text
    )
    const values = (status: string) =>
      [
        ...new Set(
          mine
            .filter((redaction) => redaction.status === status)
            .map((redaction) => redaction.text as string)
        ),
      ].slice(0, 30)
    return { accepted: values("accepted"), rejected: values("rejected") }
  }, [redactions, rule.copyId])

  const body = {
    mode: "improve" as const,
    spec: {
      kind: rule.kind,
      pattern: rule.pattern,
      matchCase: rule.matchCase,
      wholeWord: rule.wholeWord,
    },
    accepted,
    rejected,
  }

  async function send() {
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`/api/documents/${documentId}/assistant`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError(
          (await readFailure(response, "Hush could not improve this rule."))
            .message
        )
        return
      }
      setResult((await response.json()) as Improvement)
    } catch {
      setError("Hush could not be reached. Check your connection.")
    } finally {
      setBusy(false)
    }
  }

  async function accept() {
    if (!result) return
    const done = await update(rule, { spec: result.spec })
    if (done) dispatch(assistantToggled(null))
  }

  return (
    <section aria-labelledby="hush-improve" className="flex flex-col gap-3">
      <h3 id="hush-improve" className="label-micro">
        Improve a rule
      </h3>
      <p className="font-mono text-xs break-all text-white">/{rule.pattern}/</p>

      <div className="rounded-md bg-surface-3 p-2.5 text-[11px] leading-relaxed text-text-muted">
        <p className="text-text-secondary">Hush will send the AI provider:</p>
        <ul className="mt-1 list-disc pl-4">
          <li>the pattern and its options</li>
          <li>
            {accepted.length} {accepted.length === 1 ? "value" : "values"} you
            accepted and {rejected.length} you rejected, as values only
          </li>
        </ul>
        <p className="mt-1">
          No surrounding text, and nothing else from the document.
        </p>
      </div>

      {rejected.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-text-muted">
          Reject the matches this rule should not have made first; Hush tightens
          the pattern against them.
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2">
        {error ? <p className="mr-auto text-xs text-primary">{error}</p> : null}
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={!available || busy}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Improve with Hush
        </Button>
      </div>

      {result ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-border p-3"
          aria-live="polite"
        >
          <p className="font-mono text-xs break-all text-white">
            /{result.spec.pattern}/
          </p>
          <p className="text-xs leading-relaxed text-text-secondary">
            {result.explanation}
          </p>
          {result.problem ? (
            <p className="text-xs text-primary">{result.problem}</p>
          ) : result.diff ? (
            <>
              <p className="text-xs text-white">
                {result.diff.before.toLocaleString("en")} matches now,{" "}
                {result.diff.after.toLocaleString("en")} after: gains{" "}
                {result.diff.gainedCount}, loses {result.diff.lostCount}.
              </p>
              {result.diff.gained.length > 0 ? (
                <div>
                  <p className="pb-1 text-[11px] text-text-muted">
                    Would start matching
                  </p>
                  <MatchSamples
                    samples={result.diff.gained}
                    tone="gained"
                    label="Gained matches"
                  />
                </div>
              ) : null}
              {result.diff.lost.length > 0 ? (
                <div>
                  <p className="pb-1 text-[11px] text-text-muted">
                    Would stop matching
                  </p>
                  <MatchSamples
                    samples={result.diff.lost}
                    tone="lost"
                    label="Lost matches"
                  />
                </div>
              ) : null}
            </>
          ) : null}
          <div className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={Boolean(result.problem)}
              onClick={() => void accept()}
            >
              Use this pattern
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setResult(null)}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
