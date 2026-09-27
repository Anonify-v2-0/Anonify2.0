/**
 * The words and figures `pnpm ai status` prints about a sign-in and about
 * usage. Pure functions of what was read, so they are tested without a
 * terminal, a database or OpenAI (tests/ai-status.test.ts); `scripts/ai.ts`
 * does the reading and the printing.
 */

import type { ProviderUsage } from "@/lib/ai/usage-report"
import {
  planName,
  type LoginProfile,
  type SubscriptionUsage,
  type UsageWindow,
} from "@/lib/ai/providers/subscription"

import { formatTokens, formatUsd } from "./setup-ai"

export type Line = { level: "say" | "note" | "ok" | "warn"; text: string }

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "5-hour limit", "Weekly limit": what Codex CLI calls the same windows. */
export function windowLabel(seconds: number): string {
  if (seconds === 7 * 86_400) return "Weekly limit"
  if (seconds === 86_400) return "Daily limit"
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day limit`
  if (seconds % 3_600 === 0) return `${seconds / 3_600}-hour limit`
  return `${Math.round(seconds / 60)}-minute limit`
}

/** How long until `at`, the way a person says it. */
export function until(at: number, now: number): string {
  const left = at - now
  if (left <= 0) return "now"
  if (left < HOUR) return `in ${Math.max(1, Math.round(left / MINUTE))} min`
  if (left < 2 * DAY) {
    const hours = Math.floor(left / HOUR)
    const minutes = Math.round((left % HOUR) / MINUTE)
    return minutes ? `in ${hours} h ${minutes} min` : `in ${hours} h`
  }
  return `in ${Math.round(left / DAY)} days`
}

/** A 20-cell bar: 35% is seven cells full. */
export function bar(percent: number): string {
  const full = Math.round((Math.max(0, Math.min(100, percent)) / 100) * 20)
  return `${"█".repeat(full)}${"░".repeat(20 - full)}`
}

/** Enough of an ID to tell two apart, not enough to be the ID. */
export function masked(id: string): string {
  return id.length <= 8 ? id : `…${id.slice(-6)}`
}

export function accountLines(
  login: { expiresAt: number; accountId?: string; profile?: LoginProfile },
  now: number,
  /** The plan OpenAI reports now, which beats the one in an older token. */
  livePlan?: string
): Line[] {
  const plan = livePlan ?? login.profile?.plan
  const minutes = Math.round((login.expiresAt - now) / MINUTE)
  return [
    { level: "say", text: "ChatGPT account" },
    {
      level: "note",
      text: `Signed in as   ${login.profile?.email ?? "(the sign-in names no email)"}`,
    },
    {
      level: "note",
      text: `Plan           ${plan ? planName(plan) : "(not stated)"}`,
    },
    ...(login.accountId
      ? [
          {
            level: "note" as const,
            text: `Workspace      ${masked(login.accountId)}`,
          },
        ]
      : []),
    {
      level: "note",
      text: `Access token   ${
        minutes > 0
          ? `expires in ${minutes} min; refreshed on use`
          : "expired; refreshed on next use"
      }`,
    },
  ]
}

function windowLine(window: UsageWindow, now: number, indent = ""): Line {
  const label = windowLabel(window.windowSeconds).padEnd(15 - indent.length)
  const reset = window.resetsAt
    ? ` · resets ${until(window.resetsAt, now)}`
    : ""
  return {
    level: window.usedPercent >= 90 ? "warn" : "note",
    text: `${indent}${label}${bar(window.usedPercent)} ${Math.round(window.usedPercent)}% used${reset}`,
  }
}

export function planUsageLines(usage: SubscriptionUsage, now: number): Line[] {
  const lines: Line[] = [{ level: "say", text: "Plan usage (from OpenAI)" }]
  if (usage.windows.length === 0 && usage.additional.length === 0)
    lines.push({
      level: "note",
      text: "OpenAI reported no usage limits for this plan.",
    })
  for (const window of usage.windows) lines.push(windowLine(window, now))
  for (const extra of usage.additional) {
    lines.push({ level: "note", text: `${extra.name}:` })
    for (const window of extra.windows)
      lines.push(windowLine(window, now, "  "))
  }
  if (usage.credits) {
    const { hasCredits, unlimited, balance } = usage.credits
    lines.push({
      level: "note",
      text: `Credits        ${
        unlimited
          ? "unlimited"
          : hasCredits
            ? `balance ${balance ?? "available"}`
            : "none"
      }`,
    })
  }
  if (usage.limitReached || usage.allowed === false)
    lines.push({
      level: "warn",
      text: `The plan's limit is reached${
        usage.reachedType ? ` (${usage.reachedType.replace(/_/g, " ")})` : ""
      }. Model calls are refused until it resets, and the reviewer sees the contextual pass as rate-limited.`,
    })
  return lines
}

function totals(rows: ProviderUsage["today"]) {
  return rows.reduce(
    (sum, row) => ({
      calls: sum.calls + row.calls,
      inputTokens: sum.inputTokens + row.inputTokens,
      outputTokens: sum.outputTokens + row.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 }
  )
}

function summary(
  rows: ProviderUsage["today"],
  estimate: number | null
): string {
  const sum = totals(rows)
  if (sum.calls === 0) return "no calls"
  const cost =
    estimate === null
      ? " · cost unknown (no price for some model)"
      : estimate > 0
        ? ` · about ${formatUsd(estimate)}`
        : ""
  return `${sum.calls} call${sum.calls === 1 ? "" : "s"} · ${formatTokens(sum.inputTokens)} tokens in · ${formatTokens(sum.outputTokens)} out${cost}`
}

export function instanceUsageLines(
  usage: ProviderUsage,
  provider: string
): Line[] {
  const lines: Line[] = [
    { level: "say", text: `Usage by this instance (${provider})` },
    {
      level: "note",
      text: `Today (UTC)    ${summary(usage.today, usage.estimatedTodayUsd)}`,
    },
    {
      level: "note",
      text: `All time       ${summary(usage.allTime, usage.estimatedAllTimeUsd)}`,
    },
  ]
  if (usage.allTime.length > 1)
    for (const row of usage.allTime)
      lines.push({
        level: "note",
        text: `  ${row.model}: ${row.calls} call${row.calls === 1 ? "" : "s"} · ${formatTokens(row.inputTokens)} in · ${formatTokens(row.outputTokens)} out`,
      })
  return lines
}
