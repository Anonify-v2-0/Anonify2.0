"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { MatchSamples } from "@/components/rules/match-samples"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useRules } from "@/hooks/use-rules"
import { readFailure } from "@/lib/api/errors"
import {
  patternProblem,
  PATTERN_MAX_LENGTH,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import type { BatchSearchDocument, MatchPreview } from "@/lib/redaction/search"
import { cn } from "@/lib/utils"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { ruleDialogClosed, type RuleDialogRequest } from "@/store/uiSlice"
import { REDACTION_CATEGORIES } from "@/types/redaction"
import type { RuleScope } from "@/types/rules"

/**
 * Making or changing a rule, with its matches in front of the reviewer.
 *
 * Nothing is written until they confirm. As they type, the pattern is checked
 * by the same compiler the server runs, then previewed against the document —
 * the count and the first matches in context, and for a batch rule the count
 * in every other document — so the button that applies it says exactly how
 * many redactions it is about to make.
 */

const SCOPE_COPY: Record<RuleScope, { label: string; hint: string }> = {
  document: {
    label: "This document",
    hint: "Every match here.",
  },
  batch: {
    label: "Whole batch",
    hint: "Every document uploaded with this one, including any still processing.",
  },
  global: {
    label: "All my future uploads",
    hint: "Every match here, and in every document you upload from now on. Kept, encrypted, for 30 days after it last applies; export it from the rules panel to keep it longer.",
  },
}

type Preview =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ready"
      here: MatchPreview
      batch?: { documents: BatchSearchDocument[]; total: number }
    }

function initialOf(request: RuleDialogRequest): {
  spec: PatternSpec
  category: string
  scope: RuleScope
} {
  if (request.mode === "create") {
    return {
      spec: request.spec,
      category: request.category,
      scope: request.scope,
    }
  }
  const { rule } = request
  return {
    spec: {
      kind: rule.kind,
      pattern: rule.pattern,
      matchCase: rule.matchCase,
      wholeWord: rule.wholeWord,
    },
    category: rule.category,
    scope: rule.scope,
  }
}

export function RuleDialog({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const request = useAppSelector((state) => state.ui.ruleDialog)

  return (
    <Dialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) dispatch(ruleDialogClosed())
      }}
    >
      {request ? (
        // Keyed so each request starts from its own values.
        <RuleForm
          key={JSON.stringify(request)}
          documentId={documentId}
          request={request}
          onDone={() => dispatch(ruleDialogClosed())}
        />
      ) : null}
    </Dialog>
  )
}

function RuleForm({
  documentId,
  request,
  onDone,
}: {
  documentId: string
  request: RuleDialogRequest
  onDone: () => void
}) {
  const initial = initialOf(request)
  const [spec, setSpec] = useState<PatternSpec>(initial.spec)
  const [category, setCategory] = useState(initial.category)
  const [scope, setScope] = useState<RuleScope>(initial.scope)
  const [preview, setPreview] = useState<Preview>({ state: "idle" })
  const [saving, setSaving] = useState(false)
  const inBatch = useAppSelector(
    (state) => (state.document.summary?.batch?.total ?? 0) > 1
  )
  const { create, update } = useRules(documentId, false)

  const editing = request.mode === "edit" ? request.rule : null
  const problem = patternProblem(spec)
  const scopes: RuleScope[] = editing
    ? [editing.scope]
    : inBatch
      ? ["document", "batch", "global"]
      : ["document", "global"]

  // Preview as the reviewer types, once the pattern is one the server would run.
  const previewKey = JSON.stringify([spec, scope])
  useEffect(() => {
    if (problem) return
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setPreview({ state: "loading" })
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
        if (!response.ok) {
          const failure = await readFailure(
            response,
            "This pattern could not be previewed."
          )
          setPreview({ state: "error", message: failure.message })
          return
        }
        const payload = (await response.json()) as {
          here: MatchPreview
          batch?: { documents: BatchSearchDocument[]; total: number }
        }
        setPreview({ state: "ready", ...payload })
      } catch (error) {
        if ((error as Error).name === "AbortError") return
        setPreview({
          state: "error",
          message: "This pattern could not be previewed.",
        })
      }
    }, 300)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // `previewKey` is the identity of spec and scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, previewKey, problem])

  const ready = !problem && preview.state === "ready"
  const count = preview.state === "ready" ? preview.here.count : 0
  const total =
    preview.state === "ready" ? (preview.batch?.total ?? preview.here.count) : 0

  async function confirm() {
    if (!ready) return
    setSaving(true)
    const done = editing
      ? await update(editing, { spec, category })
      : await create({ spec, category, scope })
    setSaving(false)
    if (done) onDone()
  }

  const confirmLabel = editing
    ? editing.enabled
      ? `Save and re-apply`
      : "Save"
    : scope === "batch"
      ? `Redact ${total.toLocaleString("en")} across the batch`
      : `Redact ${count.toLocaleString("en")} ${count === 1 ? "match" : "matches"}`

  return (
    <DialogContent className="max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {editing ? "Edit rule" : "Redact every match"}
        </DialogTitle>
        <DialogDescription>
          {editing
            ? `Changing it replaces what it redacted${
                editing.documents > 1
                  ? ` in all ${editing.documents} documents it reached`
                  : ""
              }. Matches you had rejected under the old pattern come back accepted.`
            : "Every match becomes an accepted redaction. Nothing is written until you confirm."}
        </DialogDescription>
      </DialogHeader>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pr-1">
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="rule-pattern" className="label-micro">
              Pattern
            </label>
            <div
              role="radiogroup"
              aria-label="Pattern kind"
              className="flex gap-1"
            >
              {(["literal", "regex"] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={spec.kind === kind}
                  onClick={() => setSpec({ ...spec, kind })}
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[11px] transition-colors",
                    spec.kind === kind
                      ? "bg-red-soft text-primary"
                      : "text-text-muted hover:text-white"
                  )}
                >
                  {kind === "literal" ? "Text" : "RegEx"}
                </button>
              ))}
            </div>
          </div>
          <input
            id="rule-pattern"
            value={spec.pattern}
            maxLength={PATTERN_MAX_LENGTH}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby="rule-pattern-problem"
            onChange={(event) =>
              setSpec({ ...spec, pattern: event.target.value })
            }
            className="h-9 rounded-md border border-input bg-input/30 px-2.5 font-mono text-sm text-white outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
          />
          <div className="flex flex-wrap gap-3 text-xs text-text-secondary">
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={spec.matchCase}
                onChange={(event) =>
                  setSpec({ ...spec, matchCase: event.target.checked })
                }
                className="accent-primary"
              />
              Match case
            </label>
            <label className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={spec.wholeWord}
                onChange={(event) =>
                  setSpec({ ...spec, wholeWord: event.target.checked })
                }
                className="accent-primary"
              />
              Whole word
            </label>
          </div>
          <p
            id="rule-pattern-problem"
            className="text-xs text-primary"
            aria-live="polite"
          >
            {problem ?? ""}
          </p>
          {spec.kind === "regex" ? (
            <p className="text-[11px] leading-relaxed text-text-muted">
              RE2 syntax: matched in linear time, so lookahead, lookbehind and
              backreferences are not available. <code>^</code> and{" "}
              <code>$</code> match at line breaks.
            </p>
          ) : null}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span id="rule-category" className="label-micro">
              Category
            </span>
            <Select
              value={category}
              onValueChange={(next) => setCategory(next as string)}
            >
              <SelectTrigger aria-labelledby="rule-category" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REDACTION_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="label-micro pb-2">Applies to</legend>
            {scopes.map((value) => (
              <label
                key={value}
                className="flex items-start gap-2 text-sm text-white"
              >
                <input
                  type="radio"
                  name="rule-scope"
                  value={value}
                  checked={scope === value}
                  disabled={Boolean(editing)}
                  onChange={() => setScope(value)}
                  className="mt-1 accent-primary"
                />
                <span>
                  {SCOPE_COPY[value].label}
                  <span className="block text-[11px] leading-relaxed text-text-muted">
                    {SCOPE_COPY[value].hint}
                  </span>
                </span>
              </label>
            ))}
            {request.mode === "create" && request.scopeReason ? (
              <p className="text-[11px] leading-relaxed text-text-muted">
                Suggested: {request.scopeReason}
              </p>
            ) : null}
          </fieldset>
        </div>

        <section
          aria-labelledby="rule-preview"
          aria-busy={preview.state === "loading"}
        >
          <h3 id="rule-preview" className="label-micro pb-2">
            Preview
          </h3>
          {problem ? (
            <p className="text-xs text-text-muted">
              Fix the pattern to see its matches.
            </p>
          ) : preview.state === "loading" || preview.state === "idle" ? (
            <p className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 className="size-3 animate-spin" /> Finding matches…
            </p>
          ) : preview.state === "error" ? (
            <p className="text-xs text-primary">{preview.message}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-white" aria-live="polite">
                {preview.here.count === 0
                  ? "No matches in this document."
                  : `${preview.here.count.toLocaleString("en")} ${
                      preview.here.count === 1 ? "match" : "matches"
                    } in this document${
                      preview.here.count > preview.here.samples.length
                        ? `; the first ${preview.here.samples.length} are shown`
                        : ""
                    }.`}
              </p>
              <MatchSamples
                samples={preview.here.samples}
                label="Matches in this document"
              />
              {preview.batch ? (
                <div className="flex flex-col gap-1 pt-1">
                  <p className="text-xs text-text-secondary">
                    {preview.batch.total.toLocaleString("en")} across the batch:
                  </p>
                  <ul className="flex flex-col gap-0.5 text-xs">
                    {preview.batch.documents.map((document) => (
                      <li
                        key={document.id}
                        className="flex justify-between gap-2"
                      >
                        <span className="truncate text-text-secondary">
                          {document.name}
                        </span>
                        <span className="shrink-0 text-text-muted tabular-nums">
                          {document.count ?? document.note}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {scope === "global" && !editing ? (
                <p className="text-[11px] leading-relaxed text-text-muted">
                  Documents you already have open elsewhere are not changed.
                </p>
              ) : null}
            </div>
          )}
        </section>
      </div>

      <DialogFooter>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={confirm} disabled={!ready || saving}>
          {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
          {confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
