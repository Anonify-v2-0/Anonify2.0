"use client"

import { useChat } from "@ai-sdk/react"
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  ArrowUp,
  Eraser,
  Lightbulb,
  Loader2,
  RotateCcw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  X,
} from "lucide-react"

import { HushBadges } from "@/components/assistant/hush-badges"
import { HushMarkdown } from "@/components/assistant/hush-markdown"
import {
  HushToolPart,
  isChangePart,
  type ApprovalHandlers,
  type HushToolUIPart,
} from "@/components/assistant/hush-tool-part"
import { Button } from "@/components/ui/button"
import {
  learnedRuleRequest,
  suggestedScope,
  useLearnedShapes,
} from "@/hooks/use-learned-shapes"
import { useRules } from "@/hooks/use-rules"
import type { HushUIMessage, HushView } from "@/lib/assistant/agent"
import type { HushProvider } from "@/lib/assistant/hush"
import { shortcutHint } from "@/lib/editor/shortcuts"
import { cn } from "@/lib/utils"
import { useAppDispatch, useAppSelector, useAppStore } from "@/store/hooks"
import { selectSelectedRedaction } from "@/store/selectors"
import {
  assistantToggled,
  hushOfferDismissed,
  hushReadConsentSet,
  ruleDialogOpened,
} from "@/store/uiSlice"
import type { RuleView } from "@/types/rules"

/**
 * Hush, the review assistant: an agent the reviewer talks to.
 *
 * It reads and searches the document through tools, runs the detectors, lists
 * what the review has decided — and when it wants to change anything, stops
 * and asks. Each tool call is drawn as it happens (see hush-tool-part.tsx),
 * so the reviewer sees what Hush looked at, what it found, and exactly what it
 * proposes to change before it can.
 *
 * Two kinds of question are asked in the conversation itself:
 *
 *   reading   once per document, on Hush's first read. Allowed, it holds
 *             for the rest of the session (revocable from the header);
 *             every later read is simply listed.
 *   changes   every time. A rule, a redaction, a bulk accept — each is a card
 *             with its evidence, and nothing happens until Approve.
 *
 * Learned offers — rules suggested from the reviewer's own repeated manual
 * redactions — are worked out in the browser and need no provider at all.
 */

type Status =
  | { state: "loading" }
  | { state: "ready"; available: true; model: string; provider: HushProvider }
  | {
      state: "ready"
      available: false
      reason: string
      provider?: HushProvider
    }

const UNAVAILABLE: Record<string, string> = {
  "not-configured":
    "Hush needs an AI provider, and this instance has none configured. An administrator can set one up with `pnpm ai`.",
  unsupported:
    "The configured model cannot call tools, which Hush needs. An administrator can choose another with `pnpm ai`.",
  budget:
    "This instance has reached its daily AI spend cap. Hush is back tomorrow (UTC).",
}

const STARTERS = [
  "Find anything sensitive I haven't redacted yet",
  "Where does every email address and phone number appear?",
  "Turn values I keep redacting by hand into rules",
  "Summarise what's been redacted so far",
]

function useHushStatus(open: boolean): Status {
  const [status, setStatus] = useState<Status>({ state: "loading" })
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const response = await fetch("/api/assistant", { cache: "no-store" })
        const payload = (await response.json()) as
          | { available: true; model: string; provider: HushProvider }
          | { available: false; reason: string; provider?: HushProvider }
        if (!cancelled) setStatus({ state: "ready", ...payload })
      } catch {
        if (!cancelled)
          setStatus({ state: "ready", available: false, reason: "unreachable" })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])
  return status
}

function improvePrompt(rule: RuleView): string {
  return `Improve my ${rule.scope} RegEx rule \`${rule.pattern}\` (rule id ${rule.id}, category ${rule.category}). Look at what it matched here and which of those matches I rejected, test a tighter pattern with compare_patterns, and propose the change with update_rule. Keep every match I accepted.`
}

export function HushPanel({ documentId }: { documentId: string }) {
  const dispatch = useAppDispatch()
  const store = useAppStore()
  const request = useAppSelector((state) => state.ui.assistant)
  const open = request !== null
  const status = useHushStatus(open)
  const consent = useAppSelector((state) =>
    state.ui.hushReadConsent.includes(documentId)
  )
  const { refresh } = useRules(documentId, false)

  const transport = useMemo(
    () =>
      new DefaultChatTransport<HushUIMessage>({
        api: `/api/documents/${documentId}/assistant`,
        // Read at send time, not render time: the consent the reviewer just
        // gave, and the page and selection they are on right now.
        prepareSendMessagesRequest: ({ messages }) => {
          const state = store.getState()
          const selected = selectSelectedRedaction(state)
          const view: HushView = {
            currentPage: state.editor.currentPage,
            selected: selected
              ? {
                  id: selected.id,
                  text: selected.text?.slice(0, 500),
                  category: selected.category,
                  status: selected.status,
                  source: selected.source,
                  page: selected.page,
                  reason: selected.reason?.slice(0, 300),
                }
              : undefined,
          }
          return {
            body: {
              messages,
              readConsent: state.ui.hushReadConsent.includes(documentId),
              view,
            },
          }
        },
      }),
    [documentId, store]
  )

  const {
    messages,
    sendMessage,
    status: chatStatus,
    stop,
    error,
    regenerate,
    setMessages,
    addToolApprovalResponse,
  } = useChat<HushUIMessage>({
    id: `hush-${documentId}`,
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
  })

  // A change Hush made is on the server; bring the canvas, the inspector and
  // the rules panel up to date with it, once per change.
  const applied = useRef(new Set<string>())
  useEffect(() => {
    let changed = false
    for (const message of messages) {
      for (const part of message.parts) {
        if (!("toolCallId" in part) || !isChangePart(part.type)) continue
        if (
          part.state !== "output-available" ||
          applied.current.has(part.toolCallId)
        )
          continue
        applied.current.add(part.toolCallId)
        changed = true
      }
    }
    if (changed) void refresh()
  }, [messages, refresh])

  const busy = chatStatus === "submitted" || chatStatus === "streaming"
  const available = status.state === "ready" && status.available

  // "Improve with Hush" arrives as a request; it becomes a message once.
  const improved = useRef<string | null>(null)
  useEffect(() => {
    if (request?.mode !== "improve" || !available || busy) return
    if (improved.current === request.rule.id) return
    improved.current = request.rule.id
    void sendMessage({ text: improvePrompt(request.rule) })
  }, [available, busy, request, sendMessage])

  const handlers: ApprovalHandlers = {
    approve: (part: HushToolUIPart) => {
      if (part.state !== "approval-requested") return
      if (part.approval.requestReason === "read-consent") {
        // One yes covers every read waiting on it in this turn.
        dispatch(hushReadConsentSet({ documentId, granted: true }))
        const last = messages.at(-1)
        for (const other of last?.parts ?? []) {
          if (
            "toolCallId" in other &&
            other.state === "approval-requested" &&
            other.approval.requestReason === "read-consent"
          ) {
            void addToolApprovalResponse({
              id: other.approval.id,
              approved: true,
            })
          }
        }
        return
      }
      void addToolApprovalResponse({ id: part.approval.id, approved: true })
    },
    deny: (part: HushToolUIPart) => {
      if (part.state !== "approval-requested") return
      void addToolApprovalResponse({
        id: part.approval.id,
        approved: false,
        reason:
          part.approval.requestReason === "read-consent"
            ? "The reviewer did not allow reading the document."
            : "The reviewer declined this change.",
      })
    },
  }

  if (!request) return null

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="hush-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation()
          dispatch(assistantToggled(null))
        }
      }}
      className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-surface-2 shadow-panel sm:w-[440px]"
    >
      <header className="flex flex-col gap-2.5 border-b border-border px-4 pt-3 pb-3">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-red-soft text-primary"
          >
            <Sparkles className="size-3.5" />
          </span>
          <h2
            id="hush-title"
            className="min-w-0 flex-1 text-sm font-semibold text-white"
          >
            Hush
            <span className="ml-2 font-normal text-text-muted">
              Review assistant
            </span>
          </h2>
          {consent ? (
            <Button
              variant="ghost"
              size="icon-sm"
              title="Hush may read this document. Click to stop it."
              onClick={() =>
                dispatch(hushReadConsentSet({ documentId, granted: false }))
              }
            >
              <ShieldCheck className="size-4 text-text-secondary" />
              <span className="sr-only">Stop Hush reading this document</span>
            </Button>
          ) : (
            <span
              title="Hush will ask before reading this document"
              className="px-1.5"
            >
              <ShieldOff aria-hidden className="size-4 text-text-muted" />
              <span className="sr-only">
                Hush has not been allowed to read this document
              </span>
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            title="New conversation"
            disabled={messages.length === 0 || busy}
            onClick={() => {
              applied.current.clear()
              setMessages([])
            }}
          >
            <Eraser className="size-4" />
            <span className="sr-only">New conversation</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            title={`Close (${shortcutHint("assistant")})`}
            onClick={() => dispatch(assistantToggled(null))}
          >
            <X className="size-4" />
            <span className="sr-only">Close Hush</span>
          </Button>
        </div>
        <HushBadges
          loading={status.state === "loading"}
          available={available}
          provider={status.state === "ready" ? status.provider : undefined}
        />
      </header>

      <Conversation
        messages={messages}
        busy={busy}
        streaming={chatStatus === "streaming"}
        handlers={handlers}
        empty={
          <EmptyState
            available={available}
            status={status}
            onStart={(text) => void sendMessage({ text })}
          />
        }
      />

      {error ? (
        <div
          role="alert"
          className="mx-4 mb-2 flex items-center gap-2 rounded-md border border-red-border/50 bg-red-soft px-3 py-2 text-xs text-text-secondary"
        >
          <span className="flex-1">
            {error.message && error.message.length < 300
              ? error.message
              : "Hush could not answer. Try again."}
          </span>
          <Button size="xs" variant="ghost" onClick={() => void regenerate()}>
            <RotateCcw className="size-3" /> Retry
          </Button>
        </div>
      ) : null}

      <Composer
        disabled={!available}
        busy={busy}
        onSend={(text) => void sendMessage({ text })}
        onStop={() => void stop()}
      />
    </aside>
  )
}

function Conversation({
  messages,
  busy,
  streaming,
  handlers,
  empty,
}: {
  messages: HushUIMessage[]
  busy: boolean
  streaming: boolean
  handlers: ApprovalHandlers
  empty: ReactNode
}) {
  const bottom = useRef<HTMLDivElement>(null)
  const last = messages.at(-1)
  const lastSize = last ? JSON.stringify(last.parts).length : 0

  // Follow the conversation as it grows, the way a reader of a stream does.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [messages.length, lastSize])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" aria-busy={busy}>
      {messages.length === 0 ? (
        empty
      ) : (
        <ol className="flex flex-col gap-5">
          {messages.map((message, index) => (
            <li key={message.id}>
              {message.role === "user" ? (
                <UserMessage message={message} />
              ) : (
                <AssistantMessage
                  message={message}
                  streaming={streaming && index === messages.length - 1}
                  handlers={handlers}
                />
              )}
            </li>
          ))}
          {busy && last?.role === "user" ? (
            <li className="flex items-center gap-2 text-xs text-text-muted">
              <Loader2 className="size-3.5 animate-spin" /> Hush is working…
            </li>
          ) : null}
        </ol>
      )}
      <div ref={bottom} />
    </div>
  )
}

function UserMessage({ message }: { message: HushUIMessage }) {
  const text = message.parts
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("")
  return (
    <div className="ml-10 rounded-lg rounded-tr-sm bg-white/8 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap text-white">
      {text}
    </div>
  )
}

function AssistantMessage({
  message,
  streaming,
  handlers,
}: {
  message: HushUIMessage
  streaming: boolean
  handlers: ApprovalHandlers
}) {
  const lastText = message.parts.findLastIndex((part) => part.type === "text")
  return (
    <div className="flex flex-col gap-2">
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return part.text ? (
            <HushMarkdown
              key={index}
              streaming={streaming && index === lastText}
            >
              {part.text}
            </HushMarkdown>
          ) : null
        }
        if (part.type === "reasoning") {
          return part.text ? (
            <details key={index} className="text-xs text-text-muted">
              <summary className="cursor-pointer select-none">Thinking</summary>
              <p className="mt-1 whitespace-pre-wrap">{part.text}</p>
            </details>
          ) : null
        }
        if ("toolCallId" in part) {
          return (
            <HushToolPart
              key={part.toolCallId}
              part={part}
              handlers={handlers}
            />
          )
        }
        return null
      })}
    </div>
  )
}

function EmptyState({
  available,
  status,
  onStart,
}: {
  available: boolean
  status: Status
  onStart: (text: string) => void
}) {
  const hasSelection = useAppSelector(
    (state) => state.redactions.selectedId !== null
  )
  const starters = hasSelection
    ? ["Why was the selected item flagged, and is it sensitive?", ...STARTERS]
    : STARTERS

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-white">
          What should Hush look for?
        </p>
        <p className="mt-1 text-xs leading-relaxed text-text-muted">
          Hush reads and searches this document, finds what the review missed,
          and proposes rules and redactions. It only ever proposes: every change
          waits for your approval.
        </p>
      </div>

      {status.state === "ready" && !status.available ? (
        <p className="rounded-md border border-border bg-surface-3 p-3 text-xs leading-relaxed text-text-secondary">
          {UNAVAILABLE[status.reason] ??
            "Hush cannot reach this instance's AI provider right now."}{" "}
          Search, shortcuts, rules you write yourself and the ideas below keep
          working without it.
        </p>
      ) : null}

      {available ? (
        <ul className="flex flex-col gap-1.5">
          {starters.map((starter) => (
            <li key={starter}>
              <button
                type="button"
                onClick={() => onStart(starter)}
                className="w-full rounded-md border border-border bg-surface-3/60 px-3 py-2 text-left text-xs text-text-secondary transition-colors hover:border-white/20 hover:text-white"
              >
                {starter}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <LearnedOffers />
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
      <h3 id="hush-learned" className="label-micro flex items-center gap-1.5">
        <Lightbulb className="size-3" /> From your redactions
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
              <span className="font-mono">{shape.display}</span>. Make a{" "}
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

function Composer({
  disabled,
  busy,
  onSend,
  onStop,
}: {
  disabled: boolean
  busy: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [text, setText] = useState("")
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!disabled) ref.current?.focus()
  }, [disabled])

  function send() {
    const value = text.trim()
    if (!value || busy || disabled) return
    onSend(value)
    setText("")
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        send()
      }}
      className="border-t border-border p-3"
    >
      <div className="flex items-end gap-2 rounded-lg border border-border bg-surface-3 p-2 transition-colors focus-within:border-white/25">
        <textarea
          ref={ref}
          value={text}
          disabled={disabled}
          rows={1}
          maxLength={4000}
          placeholder={
            disabled ? "Hush is unavailable" : "Ask Hush about this document…"
          }
          aria-label="Message Hush"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              send()
            }
          }}
          className="field-sizing-content max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-[13px] text-white outline-none placeholder:text-text-muted disabled:opacity-50"
        />
        {busy ? (
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            onClick={onStop}
            title="Stop"
          >
            <Square className="size-3.5 fill-current" />
            <span className="sr-only">Stop Hush</span>
          </Button>
        ) : (
          <Button
            type="submit"
            size="icon-sm"
            disabled={disabled || !text.trim()}
            className={cn(!text.trim() && "opacity-50")}
          >
            <ArrowUp className="size-4" />
            <span className="sr-only">Send</span>
          </Button>
        )}
      </div>
      <p className="mt-1.5 px-1 text-[10px] text-text-muted">
        Enter to send · Shift+Enter for a new line · Changes always wait for
        your approval
      </p>
    </form>
  )
}
