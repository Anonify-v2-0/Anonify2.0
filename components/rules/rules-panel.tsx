"use client"

import { useRef, useState } from "react"
import { Download, Pencil, Plus, Sparkles, Trash2, Upload } from "lucide-react"
import { toast } from "sonner"

import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { useRules } from "@/hooks/use-rules"
import { toastFailure } from "@/lib/api/errors"
import { describeSpec } from "@/lib/redaction/patterns"
import { useAppDispatch, useAppSelector } from "@/store/hooks"
import { assistantToggled, ruleDialogOpened } from "@/store/uiSlice"
import type { RuleScope, RuleView } from "@/types/rules"

/**
 * Every rule that reaches this document, at every scope.
 *
 * A rule redacts in places the reviewer is not looking — the rest of the
 * document, other files in the batch, uploads that have not happened yet — so
 * each one says how much it did and where, and each can be switched off,
 * edited (with a fresh preview) or removed. Removing a rule removes every
 * redaction it made, everywhere it reached, which is why it asks first.
 */

const SECTIONS: { scope: RuleScope; title: string; empty: string }[] = [
  {
    scope: "document",
    title: "This document",
    empty: "No rules of its own. Search, then “Redact all”, to make one.",
  },
  {
    scope: "batch",
    title: "This batch",
    empty: "No decisions carried across the batch yet.",
  },
  {
    scope: "global",
    title: "All my uploads",
    empty:
      "No global rules. A global rule applies to every document you upload from now on.",
  },
]

function reach(rule: RuleView): string {
  const here = `${rule.here.toLocaleString("en")} here`
  if (rule.scope === "document") return here
  const documents =
    rule.documents === 1 ? "1 document" : `${rule.documents} documents`
  return `${here} · ${rule.total.toLocaleString("en")} in ${documents}`
}

export function RulesPanel({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const rules = useAppSelector((state) =>
    state.rules.documentId === documentId ? state.rules.items : []
  )
  const status = useAppSelector((state) => state.rules.status)
  const batchId = useAppSelector(
    (state) => state.document.summary?.batch?.batchId
  )
  // Loaded by the workspace; the rail and the mobile sheet both render this.
  const { update, remove, refresh } = useRules(documentId, false)
  const importRef = useRef<HTMLInputElement>(null)

  async function importFile(file: File) {
    let body: unknown
    try {
      body = JSON.parse(await file.text())
    } catch {
      toast.error(
        "That file is not JSON. Choose a rule file exported from Anonify."
      )
      return
    }
    const response = await fetch("/api/rules/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      await toastFailure(toast, response, "Those rules could not be imported.")
      return
    }
    const result = (await response.json()) as {
      imported: number
      duplicates: number
      invalid: { index: number; problem: string }[]
    }
    const parts = [
      `Imported ${result.imported} ${result.imported === 1 ? "rule" : "rules"}`,
    ]
    if (result.duplicates) parts.push(`${result.duplicates} already present`)
    if (result.invalid.length) {
      parts.push(
        `${result.invalid.length} refused (rule ${result.invalid
          .map((entry) => entry.index + 1)
          .join(", ")}: ${result.invalid[0].problem})`
      )
    }
    toast.success(`${parts.join("; ")}. They apply to your future uploads.`)
    await refresh()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
        <p className="label-micro">Rules</p>
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            dispatch(
              ruleDialogOpened({
                mode: "create",
                spec: {
                  kind: "literal",
                  pattern: "",
                  matchCase: false,
                  wholeWord: false,
                },
                category: "other",
                scope: "document",
              })
            )
          }
        >
          <Plus className="size-3" />
          New rule
        </Button>
      </div>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-5 px-4 pb-6">
          {status === "loading" && rules.length === 0 ? (
            <p className="text-xs text-text-muted">Loading rules…</p>
          ) : null}
          {SECTIONS.filter(
            (section) => section.scope !== "batch" || batchId
          ).map((section) => {
            const items = rules.filter((rule) => rule.scope === section.scope)
            return (
              <section
                key={section.scope}
                aria-labelledby={`rules-${section.scope}`}
              >
                <div className="flex items-center justify-between gap-2 pb-2">
                  <h3
                    id={`rules-${section.scope}`}
                    className="text-xs font-medium text-text-secondary"
                  >
                    {section.title}
                  </h3>
                  {section.scope === "global" ? (
                    <div className="flex gap-1">
                      {/* A link, not a Button: a download keeps its link
                            semantics for a screen reader and a middle-click. */}
                      <a
                        href="/api/rules/export"
                        download
                        title="Export global rules as JSON"
                        className={buttonVariants({
                          size: "icon-xs",
                          variant: "ghost",
                        })}
                      >
                        <Download className="size-3" />
                        <span className="sr-only">Export global rules</span>
                      </a>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        title="Import global rules from JSON"
                        onClick={() => importRef.current?.click()}
                      >
                        <Upload className="size-3" />
                        <span className="sr-only">Import global rules</span>
                      </Button>
                      <input
                        ref={importRef}
                        type="file"
                        accept="application/json,.json"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0]
                          event.target.value = ""
                          if (file) void importFile(file)
                        }}
                      />
                    </div>
                  ) : null}
                </div>
                {items.length === 0 ? (
                  <p className="text-[11px] leading-relaxed text-text-muted">
                    {section.empty}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {items.map((rule) => (
                      <RuleRow
                        key={rule.id}
                        rule={rule}
                        onToggle={(enabled) => void update(rule, { enabled })}
                        onEdit={() =>
                          dispatch(ruleDialogOpened({ mode: "edit", rule }))
                        }
                        onImprove={() =>
                          dispatch(assistantToggled({ mode: "improve", rule }))
                        }
                        onRemove={() => void remove(rule)}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

function RuleRow({
  rule,
  onToggle,
  onEdit,
  onImprove,
  onRemove,
}: {
  rule: RuleView
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onImprove: () => void
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  const name = rule.kind === "regex" ? `/${rule.pattern}/` : `“${rule.pattern}”`

  return (
    <li className="rounded-md border border-border bg-surface-3/60 p-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p
            className="truncate font-mono text-xs text-white"
            title={rule.pattern}
          >
            {name}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            <span className="tracking-wide uppercase">{rule.category}</span> ·{" "}
            {describeSpec(rule)}
          </p>
          <p className="mt-0.5 text-[11px] text-text-muted">
            {rule.enabled ? reach(rule) : "Switched off: redacts nothing"}
          </p>
        </div>
        <Switch
          size="sm"
          checked={rule.enabled}
          onCheckedChange={(checked) => onToggle(checked)}
          aria-label={`${rule.enabled ? "Switch off" : "Switch on"} the rule ${name}`}
        />
      </div>

      {confirming ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-text-secondary">
            Remove it and its {rule.total.toLocaleString("en")}{" "}
            {rule.total === 1 ? "redaction" : "redactions"}
            {rule.documents > 1 ? ` in ${rule.documents} documents` : ""}?
          </span>
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              setConfirming(false)
              onRemove()
            }}
          >
            Remove
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setConfirming(false)}
          >
            Keep
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1">
          <Button size="xs" variant="ghost" onClick={onEdit}>
            <Pencil className="size-3" />
            Edit
          </Button>
          {rule.kind === "regex" ? (
            <Button size="xs" variant="ghost" onClick={onImprove}>
              <Sparkles className="size-3" />
              Improve with Hush
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setConfirming(true)}
            aria-label={`Remove the rule ${name}`}
          >
            <Trash2 className="size-3" />
            Remove
          </Button>
        </div>
      )}
    </li>
  )
}
