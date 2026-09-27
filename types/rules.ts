import type { PatternKind } from "@/lib/redaction/patterns"

/**
 * Rules as the editor sees them.
 *
 * Three scopes, one shape. A document rule reaches this document; a batch rule
 * reaches every document uploaded with it, including ones still processing; a
 * global rule reaches every document its owner uploads from now on. The rules
 * panel lists all three for the document on screen, because "why is this
 * redacted?" is asked here whichever scope the answer lives in.
 */

export const RULE_SCOPE_NAMES = ["document", "batch", "global"] as const

export type RuleScope = (typeof RULE_SCOPE_NAMES)[number]

export type RuleView = {
  id: string
  scope: RuleScope
  kind: PatternKind
  pattern: string
  matchCase: boolean
  wholeWord: boolean
  category: string
  enabled: boolean
  createdAt: string
  /** Redactions it made in the document on screen. */
  here: number
  /** Redactions it made everywhere it reached. */
  total: number
  /** Documents it reached. */
  documents: number
  /**
   * The id this document's redactions carry in `ruleId`: the rule itself at
   * document scope, this document's copy of it otherwise. Null when the rule
   * has not reached this document.
   */
  copyId: string | null
  /** Only for a global rule: when it goes if nobody uses it. */
  expiresAt?: string
}
