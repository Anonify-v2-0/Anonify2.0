"use client"

import type { ReactNode } from "react"
import {
  CircleOff,
  Cloud,
  Cpu,
  HardDrive,
  Route,
  ShieldCheck,
  UserRound,
} from "lucide-react"

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { HushProvider } from "@/lib/assistant/hush"
import { cn } from "@/lib/utils"

/**
 * Where Hush's answers come from, as badges in its header: the provider, the
 * model, and — because it changes what "sent to the provider" means — whether
 * that provider is hosted, local, a ChatGPT plan or a gateway. Each badge says
 * the rest on hover, so the header stays one line.
 *
 * Icons describe the kind of provider rather than the vendor's mark: every
 * vendor this instance supports gets the same treatment, and none of them
 * needs a logo shipped in the bundle to be recognisable by name.
 */

const KIND: Record<
  HushProvider["kind"],
  { icon: ReactNode; label: string; hint: string }
> = {
  cloud: {
    icon: <Cloud className="size-3" />,
    label: "Hosted API",
    hint: "A hosted API: what Hush reads is sent to this provider, billed per call and bound by the instance's spend cap.",
  },
  local: {
    icon: <HardDrive className="size-3" />,
    label: "Local",
    hint: "A model running on this instance's own machine: nothing Hush reads leaves it, and it costs nothing per call.",
  },
  subscription: {
    icon: <UserRound className="size-3" />,
    label: "ChatGPT plan",
    hint: "Runs on the ChatGPT subscription signed in with `pnpm ai login`: what Hush reads is sent to OpenAI under that plan's terms and limits.",
  },
  gateway: {
    icon: <Route className="size-3" />,
    label: "Gateway",
    hint: "Routed through the Vercel AI Gateway to the model's own vendor, billed per call and bound by the instance's spend cap.",
  },
}

function Badge({
  icon,
  children,
  hint,
  tone = "default",
  mono,
}: {
  icon: ReactNode
  children: ReactNode
  hint: string
  tone?: "default" | "muted" | "positive"
  mono?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className={cn(
              "inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-full border px-2 text-[10.5px] leading-none whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tone === "positive"
                ? "border-white/15 bg-white/8 text-white"
                : tone === "muted"
                  ? "border-border text-text-muted"
                  : "border-border bg-white/4 text-text-secondary"
            )}
          >
            <span aria-hidden className="shrink-0 opacity-80">
              {icon}
            </span>
            <span
              className={cn("truncate", mono && "font-mono tracking-tight")}
            >
              {children}
            </span>
          </span>
        }
      />
      <TooltipContent className="max-w-64 leading-relaxed">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

export function HushBadges({
  loading,
  available,
  provider,
}: {
  loading: boolean
  available: boolean
  provider?: HushProvider
}) {
  if (loading) {
    return (
      <div aria-hidden className="flex gap-1.5">
        <span className="h-5 w-24 animate-pulse rounded-full bg-white/6" />
        <span className="h-5 w-20 animate-pulse rounded-full bg-white/6" />
      </div>
    )
  }

  if (!provider) {
    return (
      <Badge
        icon={<CircleOff className="size-3" />}
        tone="muted"
        hint="No AI provider is configured on this instance."
      >
        No provider
      </Badge>
    )
  }

  const kind = KIND[provider.kind]

  return (
    <div
      role="list"
      aria-label="Model in use"
      className="flex min-w-0 flex-wrap items-center gap-1.5"
    >
      <span role="listitem" className="min-w-0">
        <Badge icon={kind.icon} hint={kind.hint}>
          {provider.label}
        </Badge>
      </span>
      {provider.model ? (
        <span role="listitem" className="min-w-0">
          <Badge
            icon={<Cpu className="size-3" />}
            hint={`Model: ${provider.model}`}
            mono
          >
            {provider.model}
          </Badge>
        </span>
      ) : null}
      {provider.kind === "local" ? (
        <span role="listitem">
          <Badge
            icon={<ShieldCheck className="size-3" />}
            tone="positive"
            hint={kind.hint}
          >
            Stays on this machine
          </Badge>
        </span>
      ) : null}
      {!available ? (
        <span role="listitem">
          <Badge
            icon={<CircleOff className="size-3" />}
            tone="muted"
            hint="Hush cannot use this provider right now; the message below says why."
          >
            Unavailable
          </Badge>
        </span>
      ) : null}
    </div>
  )
}
