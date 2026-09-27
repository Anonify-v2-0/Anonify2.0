import { tool } from "ai"
import { z } from "zod"

import { suggestionKeyOf } from "@/lib/assistant/keys"
import {
  cellReference,
  parseReference,
  textReference,
} from "@/lib/assistant/references"
import { prisma } from "@/lib/database/prisma"
import { newRedactionId } from "@/lib/documents/ids"
import { readNormalized } from "@/lib/documents/normalized-store"
import { normalizeValue } from "@/lib/documents/shared/text"
import { detectPatterns } from "@/lib/redaction/detectors"
import { fromDatabaseRow, toDatabaseRow } from "@/lib/redaction/model"
import { createOwnerRule, updateOwnerRule } from "@/lib/redaction/owner-rules"
import {
  compilePattern,
  PATTERN_KINDS,
  PATTERN_MAX_LENGTH,
  PatternBudgetError,
  PatternError,
  type PatternSpec,
} from "@/lib/redaction/patterns"
import { rulesInScope } from "@/lib/redaction/rule-listing"
import {
  applyRuleToDocument,
  createBatchRule,
  documentRuleReason,
  updateBatchRule,
  updateDocumentRule,
  type RuleTarget,
} from "@/lib/redaction/rules"
import {
  diffMatches,
  previewMatches,
  sampleAround,
} from "@/lib/redaction/search"
import { REDACTION_CATEGORIES, type Redaction } from "@/types/redaction"

/**
 * What Hush can do, as tools the model calls.
 *
 * Two kinds, and the difference is the whole design:
 *
 *   reads    look at the document and the review. They run without asking —
 *            once the reviewer has let Hush read this document at all (see
 *            `READ_TOOLS` and the approval policy in agent.ts).
 *   writes   change the review: a rule, a redaction, a suggestion's status.
 *            Every one stops for the reviewer's approval, shown with exactly
 *            what it will change, and runs only after they approve it.
 *
 * Every write re-validates on the server what the model asked for — a
 * reference must still point at the text it claimed, a rule must compile and
 * fit its budget — because the model's input is a proposal, not a fact.
 */

export type HushContext = {
  documentId: string
  target: RuleTarget
  batchId: string | null
  /** The owner's key, for global rules. */
  ownerKey: string
  name: string
  kind: string
}

/** Cap on what one read returns, so a tool result cannot flood the context. */
const PAGE_CHARS = 8_000
const LIST_LIMIT = 100

const specShape = {
  kind: z
    .enum(PATTERN_KINDS)
    .describe(
      "literal: exact text. regex: RE2 syntax, no lookaround or backreferences."
    ),
  pattern: z.string().min(1).max(PATTERN_MAX_LENGTH),
  matchCase: z.boolean().default(false),
  wholeWord: z.boolean().default(true),
}

const specSchema = z.object(specShape)

const scopeSchema = z
  .enum(["document", "batch", "global"])
  .describe(
    "document: this file. batch: every file uploaded with it. global: every future upload by this reviewer."
  )

const categorySchema = z.enum(REDACTION_CATEGORIES)

/** A tool that stops rather than throws: the model reads the reason and adapts. */
function refusal(error: unknown): { error: string } {
  if (error instanceof PatternError || error instanceof PatternBudgetError) {
    return { error: error.message }
  }
  throw error
}

async function redactionsOf(documentId: string): Promise<Redaction[]> {
  const rows = await prisma.redaction.findMany({ where: { documentId } })
  return rows.map(fromDatabaseRow)
}

type Coverage = "accepted" | "suggested" | "rejected" | null

/**
 * Whether the review already has a place in hand: redacted, or flagged and
 * waiting on the reviewer. A rejected redaction is neither — the reviewer
 * decided to keep the value in the file — so it counts as uncovered, which is
 * what "not redacted" means to anyone reading the answer.
 */
function flags(state: Coverage): boolean {
  return state === "accepted" || state === "suggested"
}

/** Whether something already covers a place, and how decided it is. */
function coverageFinder(redactions: Redaction[]) {
  const rank = { accepted: 3, suggested: 2, rejected: 1 } as const
  const best = (found: Redaction[]): Coverage =>
    found.reduce<Coverage>(
      (current, redaction) =>
        !current || rank[redaction.status] > rank[current]
          ? redaction.status
          : current,
      null
    )

  return {
    text(page: number, start: number, end: number): Coverage {
      return best(
        redactions.filter(
          (redaction) =>
            (redaction.page ?? 1) === page &&
            redaction.start !== undefined &&
            redaction.end !== undefined &&
            redaction.start < end &&
            redaction.end > start
        )
      )
    },
    cell(sheet: string, row: number, column: number): Coverage {
      return best(
        redactions.filter(
          (redaction) =>
            redaction.worksheet === sheet &&
            ((redaction.type === "cell" &&
              redaction.row === row &&
              redaction.column === column) ||
              (redaction.type === "row" && redaction.row === row) ||
              (redaction.type === "column" && redaction.column === column))
        )
      )
    },
  }
}

export function hushTools(context: HushContext) {
  const reader = () => readNormalized(context.target)

  return {
    // --- reads ---------------------------------------------------------------

    get_document_overview: tool({
      description:
        "What the document is and where its review stands: kind, pages or sheets, and counts of redactions by status, source and category. Contains no document text. Start here.",
      inputSchema: z.object({}),
      execute: async () => {
        const outline = await reader().outline()
        const redactions = await redactionsOf(context.documentId)
        const tally = (pick: (redaction: Redaction) => string) =>
          redactions.reduce<Record<string, number>>((counts, redaction) => {
            const key = pick(redaction)
            counts[key] = (counts[key] ?? 0) + 1
            return counts
          }, {})
        return {
          name: context.name,
          kind: context.kind,
          pages: outline.pageCount,
          sheets: (outline.sheets ?? []).map((sheet, index) => ({
            index,
            name: sheet.name,
            rows: sheet.rowCount,
            columns: sheet.columnCount,
            hidden: sheet.visibility ?? null,
          })),
          inBatch: context.batchId !== null,
          redactions: {
            total: redactions.length,
            byStatus: tally((redaction) => redaction.status),
            bySource: tally((redaction) => redaction.source),
            byCategory: tally((redaction) => redaction.category),
          },
        }
      },
    }),

    read_page: tool({
      description:
        "The text of one page, from a character offset. Long pages come back in parts: call again with nextOffset to continue.",
      inputSchema: z.object({
        page: z.number().int().min(1),
        offset: z.number().int().min(0).default(0),
      }),
      execute: async ({ page, offset }) => {
        const found = await reader().page(page)
        if (!found) return { error: `There is no page ${page}.` }
        const text = found.text.slice(offset, offset + PAGE_CHARS)
        const next = offset + text.length
        return {
          page,
          offset,
          text,
          totalChars: found.text.length,
          nextOffset: next < found.text.length ? next : null,
          ocr: found.ocr ?? false,
        }
      },
    }),

    read_sheet: tool({
      description:
        "Rows of one spreadsheet sheet, by sheet index from the overview.",
      inputSchema: z.object({
        sheet: z.number().int().min(0),
        fromRow: z.number().int().min(1).default(1),
        rows: z.number().int().min(1).max(100).default(50),
      }),
      execute: async ({ sheet, fromRow, rows }) => {
        const { sheets } = await reader().outline()
        const found = sheets?.[sheet]
        if (!found) return { error: `There is no sheet ${sheet}.` }
        const until = fromRow + rows
        return {
          sheet: found.name,
          headers: found.headers,
          cells: found.cells
            .filter(
              (cell) => cell.row >= fromRow && cell.row < until && cell.value
            )
            .map((cell) => ({
              ref: cellReference(sheet, cell.row, cell.column),
              row: cell.row,
              column: cell.column,
              value: cell.value,
            })),
          moreRows: until <= found.rowCount,
        }
      },
    }),

    find_occurrences: tool({
      description:
        "Every place a value or pattern occurs, with page, context, a ref to act on, and its state: accepted (redacted), suggested (flagged, awaiting review), rejected (the reviewer chose to keep it in the file) or null (nothing addresses it). `uncovered` counts rejected and null across every occurrence. Use it to answer 'where does X appear' and before proposing any redaction.",
      inputSchema: specSchema.extend({
        limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
      }),
      execute: async ({ limit, ...spec }) => {
        try {
          const compiled = compilePattern(spec)
          const covered = coverageFinder(await redactionsOf(context.documentId))
          const occurrences: {
            ref: string
            page?: number
            sheet?: string
            text: string
            before?: string
            after?: string
            covered: Coverage
          }[] = []
          const byPage: Record<number, number> = {}
          let total = 0
          // Counted over every occurrence, not only the ones listed.
          let uncovered = 0

          for await (const page of reader().pages()) {
            for (const range of compiled.find(page.text)) {
              total += 1
              byPage[page.number] = (byPage[page.number] ?? 0) + 1
              const state = covered.text(page.number, range.start, range.end)
              if (!flags(state)) uncovered += 1
              if (occurrences.length >= limit) continue
              const around = sampleAround(page.text, range)
              occurrences.push({
                ref: textReference(page.number, range.start, range.end),
                page: page.number,
                text: around.match,
                before: around.before,
                after: around.after,
                covered: state,
              })
            }
          }

          const { sheets } = await reader().outline()
          for (const [index, sheet] of (sheets ?? []).entries()) {
            for (const cell of sheet.cells) {
              if (!cell.value || compiled.find(cell.value).length === 0)
                continue
              total += 1
              const state = covered.cell(sheet.name, cell.row, cell.column)
              if (!flags(state)) uncovered += 1
              if (occurrences.length >= limit) continue
              occurrences.push({
                ref: cellReference(index, cell.row, cell.column),
                sheet: sheet.name,
                text: cell.value,
                covered: state,
              })
            }
          }

          return {
            spec: compiled.spec,
            total,
            byPage,
            uncovered,
            occurrences,
            truncated: total > occurrences.length,
          }
        } catch (error) {
          return refusal(error)
        }
      },
    }),

    find_uncovered: tool({
      description:
        "Runs the deterministic detectors (emails, phones, IDs, cards, IBANs, addresses, credentials, dates of birth…) over the whole document and returns what no redaction covers yet, grouped by category and value, with refs. Names and context-dependent secrets need read_page and your own judgement.",
      inputSchema: z.object({
        categories: z.array(categorySchema).optional(),
      }),
      execute: async ({ categories }) => {
        const covered = coverageFinder(await redactionsOf(context.documentId))
        const wanted = categories ? new Set<string>(categories) : null
        const groups = new Map<
          string,
          {
            category: string
            value: string
            refs: string[]
            pages: number[]
            reason?: string
          }
        >()

        const add = (
          category: string,
          value: string,
          ref: string,
          page?: number,
          reason?: string
        ) => {
          if (wanted && !wanted.has(category)) return
          const key = `${category}|${normalizeValue(value)}`
          const group = groups.get(key) ?? {
            category,
            value,
            refs: [],
            pages: [],
            reason,
          }
          if (group.refs.length < 20) group.refs.push(ref)
          if (page && !group.pages.includes(page)) group.pages.push(page)
          groups.set(key, group)
        }

        for await (const page of reader().pages()) {
          for (const found of detectPatterns(page.text, {
            page: page.number,
          })) {
            if (found.start === undefined || found.end === undefined) continue
            if (flags(covered.text(page.number, found.start, found.end))) continue
            add(
              found.category,
              found.text,
              textReference(page.number, found.start, found.end),
              page.number,
              found.reason
            )
          }
        }

        const { sheets } = await reader().outline()
        for (const [index, sheet] of (sheets ?? []).entries()) {
          for (const cell of sheet.cells) {
            if (!cell.value) continue
            if (flags(covered.cell(sheet.name, cell.row, cell.column))) continue
            for (const found of detectPatterns(cell.value)) {
              add(
                found.category,
                found.text,
                cellReference(index, cell.row, cell.column),
                undefined,
                found.reason
              )
              break
            }
          }
        }

        const all = [...groups.values()]
        return {
          groups: all.slice(0, LIST_LIMIT).map((group) => ({
            ...group,
            occurrences: group.refs.length,
          })),
          totalGroups: all.length,
        }
      },
    }),

    list_suggestions: tool({
      description:
        "The review's redactions grouped the way the inspector groups them — one row per value and category — with a key to act on the whole group, the statuses in it, source, confidence and the detector's or model's reason.",
      inputSchema: z.object({
        status: z
          .enum(["suggested", "accepted", "rejected", "all"])
          .default("suggested"),
        category: categorySchema.optional(),
        source: z.enum(["ai", "user", "rule"]).optional(),
        limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
      }),
      execute: async ({ status, category, source, limit }) => {
        const redactions = (await redactionsOf(context.documentId)).filter(
          (redaction) =>
            (status === "all" || redaction.status === status) &&
            (!category || redaction.category === category) &&
            (!source || redaction.source === source)
        )
        const groups = new Map<
          string,
          {
            key: string
            text: string
            category: string
            source: string
            count: number
            statuses: Record<string, number>
            pages: number[]
            confidence?: number
            reason?: string
          }
        >()
        for (const redaction of redactions) {
          const key = suggestionKeyOf(redaction)
          const group = groups.get(key) ?? {
            key,
            text: redaction.text ?? redaction.category,
            category: redaction.category,
            source: redaction.source,
            count: 0,
            statuses: {},
            pages: [],
            confidence: redaction.confidence,
            reason: redaction.reason,
          }
          group.count += 1
          group.statuses[redaction.status] =
            (group.statuses[redaction.status] ?? 0) + 1
          if (redaction.page && !group.pages.includes(redaction.page))
            group.pages.push(redaction.page)
          groups.set(key, group)
        }
        const all = [...groups.values()].sort((a, b) => b.count - a.count)
        return { groups: all.slice(0, limit), totalGroups: all.length }
      },
    }),

    list_rules: tool({
      description:
        "Every rule reaching this document, at every scope, with how much it redacted.",
      inputSchema: z.object({}),
      execute: async () => ({
        rules: await rulesInScope({
          documentId: context.documentId,
          batchId: context.batchId,
          ownerKey: context.ownerKey,
        }),
      }),
    }),

    preview_rule: tool({
      description:
        "What a rule would do before anyone creates it: the count here and the first matches in context. Always preview a pattern before proposing it.",
      inputSchema: specSchema,
      execute: async (spec) => {
        try {
          return await previewMatches(reader(), compilePattern(spec), {
            samples: 8,
          })
        } catch (error) {
          return refusal(error)
        }
      },
    }),

    compare_patterns: tool({
      description:
        "The matches a proposed pattern would gain and lose against a current one, in this document. Use it when tightening or loosening a rule.",
      inputSchema: z.object({ current: specSchema, proposed: specSchema }),
      execute: async ({ current, proposed }) => {
        try {
          return await diffMatches(
            reader(),
            compilePattern(current),
            compilePattern(proposed),
            {
              samples: 10,
            }
          )
        } catch (error) {
          return refusal(error)
        }
      },
    }),

    // --- writes: every one waits for the reviewer --------------------------------

    create_rule: tool({
      description:
        "Creates a rule that redacts every match at the given scope. The reviewer approves it first, after seeing its preview. Prefer this for any value or shape that recurs.",
      inputSchema: specSchema.extend({
        category: categorySchema,
        scope: scopeSchema,
        reason: z
          .string()
          .max(300)
          .describe("One sentence the reviewer reads on the approval card."),
      }),
      execute: async ({
        category,
        scope,
        kind,
        pattern,
        matchCase,
        wholeWord,
      }) => {
        const spec = { kind, pattern, matchCase, wholeWord }
        try {
          if (scope === "batch") {
            if (!context.batchId)
              return { error: "This document is not part of a batch." }
            const result = await createBatchRule({
              batchId: context.batchId,
              spec,
              category,
              originDocumentId: context.documentId,
            })
            return {
              created: true,
              scope,
              documents: result.applied.length,
              redactions: result.applied.reduce(
                (sum, entry) => sum + entry.redactions.length,
                0
              ),
            }
          }
          if (scope === "global") {
            const result = await createOwnerRule({
              ownerKey: context.ownerKey,
              spec,
              category,
              origin: context.target,
            })
            return {
              created: true,
              scope,
              redactions: result.redactions.length,
            }
          }
          const result = await applyRuleToDocument({
            target: context.target,
            spec,
            category,
            reason: documentRuleReason(spec),
          })
          return { created: true, scope, redactions: result.redactions.length }
        } catch (error) {
          return refusal(error)
        }
      },
    }),

    update_rule: tool({
      description:
        "Switches a rule off or on, or changes its pattern or category, everywhere it reaches. The reviewer approves it first.",
      inputSchema: z.object({
        ruleId: z.string(),
        scope: scopeSchema,
        enabled: z.boolean().optional(),
        spec: specSchema.optional(),
        category: categorySchema.optional(),
        reason: z.string().max(300),
      }),
      execute: async ({ ruleId, scope, enabled, spec, category }) => {
        try {
          const changes = { enabled, spec, category }
          const result =
            scope === "document"
              ? await updateDocumentRule({
                  target: context.target,
                  ruleId,
                  ...changes,
                })
              : scope === "batch"
                ? context.batchId
                  ? await updateBatchRule({
                      batchId: context.batchId,
                      batchRuleId: ruleId,
                      ...changes,
                    })
                  : null
                : await updateOwnerRule({
                    ownerKey: context.ownerKey,
                    ownerRuleId: ruleId,
                    ...changes,
                  })
          return result
            ? { updated: true }
            : { error: "No such rule reaches this document." }
        } catch (error) {
          return refusal(error)
        }
      },
    }),

    redact_occurrences: tool({
      description:
        "Redacts specific occurrences, by the refs find_occurrences, find_uncovered or read_sheet returned, each with the exact text at that ref. For one-off values; use create_rule for anything that recurs. The reviewer approves the list first.",
      inputSchema: z.object({
        items: z
          .array(
            z.object({ ref: z.string(), text: z.string().min(1).max(500) })
          )
          .min(1)
          .max(200),
        category: categorySchema,
        reason: z.string().max(300),
      }),
      execute: async ({ items, category, reason }) => {
        const outline = await reader().outline()
        const pages = new Map<number, string>()
        const created: Redaction[] = []
        const refused: { ref: string; problem: string }[] = []

        for (const item of items) {
          const ref = parseReference(item.ref)
          if (!ref) {
            refused.push({ ref: item.ref, problem: "not a reference" })
            continue
          }
          if (ref.kind === "text") {
            if (!pages.has(ref.page)) {
              const page = await reader().page(ref.page)
              pages.set(ref.page, page?.text ?? "")
            }
            const actual = pages.get(ref.page)?.slice(ref.start, ref.end)
            if (actual !== item.text) {
              refused.push({
                ref: item.ref,
                problem: "the text there is not what was approved",
              })
              continue
            }
            created.push({
              id: newRedactionId(),
              documentId: context.documentId,
              type: "text",
              source: "ai",
              category,
              confidence: 1,
              status: "accepted",
              page: ref.page,
              text: actual,
              start: ref.start,
              end: ref.end,
              reason: `Added by Hush with your approval: ${reason}`.slice(
                0,
                300
              ),
            })
          } else {
            const sheet = outline.sheets?.[ref.sheet]
            const value = sheet?.cells.find(
              (cell) => cell.row === ref.row && cell.column === ref.column
            )?.value
            if (!sheet || !value || !value.includes(item.text)) {
              refused.push({
                ref: item.ref,
                problem: "the cell does not hold what was approved",
              })
              continue
            }
            created.push({
              id: newRedactionId(),
              documentId: context.documentId,
              type: "cell",
              source: "ai",
              category,
              confidence: 1,
              status: "accepted",
              worksheet: sheet.name,
              row: ref.row,
              column: ref.column,
              text: value,
              reason: `Added by Hush with your approval: ${reason}`.slice(
                0,
                300
              ),
            })
          }
        }

        if (created.length > 0) {
          await prisma.redaction.createMany({
            data: created.map((redaction) => toDatabaseRow(redaction)),
          })
        }
        return { redacted: created.length, refused }
      },
    }),

    set_suggestion_status: tool({
      description:
        "Accepts or rejects whole suggestion groups, by the keys list_suggestions returned. Accepting redacts every occurrence in the group; rejecting keeps them in the export. The reviewer approves it first.",
      inputSchema: z.object({
        keys: z.array(z.string()).min(1).max(100),
        status: z.enum(["accepted", "rejected"]),
        reason: z.string().max(300),
      }),
      execute: async ({ keys, status }) => {
        const wanted = new Set(keys)
        const ids = (await redactionsOf(context.documentId))
          .filter((redaction) => wanted.has(suggestionKeyOf(redaction)))
          .map((redaction) => redaction.id)
        if (ids.length === 0)
          return { error: "None of those groups exist in this document." }
        const result = await prisma.redaction.updateMany({
          where: { documentId: context.documentId, id: { in: ids } },
          data: { status },
        })
        return { updated: result.count, status }
      },
    }),
  }
}

export type HushTools = ReturnType<typeof hushTools>
export type HushToolName = keyof HushTools

/** Tools that return document text: the first one needs the reviewer's yes. */
export const READ_TOOLS: readonly HushToolName[] = [
  "read_page",
  "read_sheet",
  "find_occurrences",
  "find_uncovered",
  "list_suggestions",
  "list_rules",
  "preview_rule",
  "compare_patterns",
]

/** Tools that change the review: every call waits for the reviewer. */
export const WRITE_TOOLS: readonly HushToolName[] = [
  "create_rule",
  "update_rule",
  "redact_occurrences",
  "set_suggestion_status",
]

export type { PatternSpec }
