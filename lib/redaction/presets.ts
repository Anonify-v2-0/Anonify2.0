import { z } from "zod"

import data from "@/lib/redaction/presets/presets.json"

/**
 * Redaction presets: named sets of detectors and categories.
 *
 * A preset narrows what the pipeline *looks for*. That is the entire claim, and
 * the copy has to keep it that way, because the tempting names are the
 * dangerous ones: a preset called "HIPAA" that somebody applies and then
 * believes they have a compliant document is a worse outcome than having no
 * presets at all. It converts a tool that helps into a tool that misleads, on
 * exactly the question where being misled is most expensive.
 *
 * So the rule is that a preset is named for what it looks for, never for what
 * it achieves — and `NAMING_RULE` below makes that a check rather than a
 * convention, because conventions are what the next contributor did not read.
 *
 * The presets themselves are data (`presets/presets.json`) so a change to what
 * a preset covers is a reviewable diff rather than a code change buried in a
 * pull request about something else.
 */

/**
 * Words that would make a preset a claim about compliance rather than a
 * description of a search. A regulation's name in a preset label is read as a
 * promise about the document, whatever the surrounding copy says.
 */
const FORBIDDEN = [
  "gdpr",
  "hipaa",
  "ccpa",
  "cpra",
  "pci",
  "dss",
  "sox",
  "ferpa",
  "glba",
  "soc 2",
  "soc2",
  "iso 27001",
  "nist",
  "compliant",
  "compliance",
  "certified",
  "certification",
  "regulation",
  "regulatory",
  "lawful",
  "legally",
  "safe harbor",
  "safe harbour",
  "anonymized",
  "anonymised",
  "guarantee",
]

const NAMING_RULE = (value: string, context: z.RefinementCtx) => {
  const lowered = value.toLowerCase()
  const hit = FORBIDDEN.find((term) => lowered.includes(term))
  if (!hit) return

  context.addIssue({
    code: "custom",
    message: `"${hit}" cannot appear in a preset's name or description: a preset says what it looks for, never what it achieves. See lib/redaction/presets.ts.`,
  })
}

const named = z.string().min(1).max(120).superRefine(NAMING_RULE)

const presetSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, "Preset ids are kebab-case")
    .superRefine(NAMING_RULE),
  label: named,
  summary: named.max(160),
  /** What a reviewer is told this preset will look for, in their words. */
  looksFor: z.array(named.max(160)).min(1).max(10),
  /** `null` means every detector; a list narrows the deterministic pass. */
  detectors: z.array(z.string().min(1)).min(1).nullable(),
  /** `null` means every category; a list narrows what the model may propose. */
  categories: z.array(z.string().min(1)).min(1).nullable(),
})

const fileSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).min(1),
})

export type Preset = z.infer<typeof presetSchema>

/**
 * Validates a preset file. Exported so the naming rule is testable on inputs
 * that must never reach the shipped data.
 */
export function parsePresets(input: unknown): Preset[] {
  return fileSchema.parse(input).presets
}

/**
 * Validated at import. A malformed or badly named preset should stop the
 * application rather than quietly change what a document was searched for.
 */
const parsed = fileSchema.parse(data)

export const PRESETS: Preset[] = parsed.presets

/** The preset that narrows nothing, which is what an upload gets by default. */
export const DEFAULT_PRESET_ID = "everything"

export function presetById(id: string | null | undefined): Preset | null {
  if (!id) return null
  return PRESETS.find((preset) => preset.id === id) ?? null
}

export function isPresetId(id: string): boolean {
  return PRESETS.some((preset) => preset.id === id)
}

/**
 * The sentence that has to appear wherever a preset is chosen.
 *
 * Not a tooltip and not a link. The one thing a person must not walk away
 * believing is that picking a preset did something to their obligations.
 */
export const PRESET_DISCLAIMER =
  "A preset changes what we look for, not what you are responsible for. It is a starting point for your review — nothing here certifies a document, and anything a preset does not look for stays in the file."

/**
 * Whether this preset actually restricts anything.
 *
 * The default preset is a preset — the person chose it — but it narrows
 * nothing, and telling them "anything outside this was not looked for" about a
 * search that looked for everything is a warning with no referent. Warnings
 * that do not apply are how real ones stop being read.
 */
export function presetNarrows(preset: Preset | null): boolean {
  return Boolean(preset && (preset.detectors || preset.categories))
}

/** Detector ids this preset runs, or `null` for all of them. */
export function detectorsFor(preset: Preset | null): readonly string[] | null {
  return preset?.detectors ?? null
}

/**
 * Whether a category survives the preset.
 *
 * Applied to what the model proposes, not only to the deterministic pass: a
 * preset that turned off the account-number detector and then accepted the
 * model's account-number suggestions would be narrowing nothing while looking
 * like it had.
 */
export function categoryAllowed(
  preset: Preset | null,
  category: string
): boolean {
  if (!preset?.categories) return true
  return preset.categories.includes(category)
}
