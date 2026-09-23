import { z } from "zod"

import { MAX_VARIANTS } from "@/lib/redaction/variants"
import { REDACTION_CATEGORIES, REDACTION_METHODS } from "@/types/redaction"

/**
 * Methods asked for by category.
 *
 * Nothing here decides whether the method is *allowed* — that is
 * lib/redaction/methods.ts, asked again at export time — so an override for a
 * mask-only category parses fine and then resolves to a mask. The schema's job
 * is to make sure the strings are ours; the policy's job is to make sure the
 * answer is defensible, and putting both here would give a client two places
 * to be told no.
 *
 * Partial, not `z.record`: in Zod 4 a record keyed by an enum is exhaustive,
 * and every real request names only the categories it wants to change — the
 * export dialog sends `categoriesAllowing(method)`, which never covers the
 * mask-only ones. An exhaustive record refused every one of those requests.
 */
const methodsSchema = z
  .partialRecord(z.enum(REDACTION_CATEGORIES), z.enum(REDACTION_METHODS))
  .optional()

const variantSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
  methods: methodsSchema,
})

/**
 * One export, or several.
 *
 * `variants` is how a reviewer gets two outputs from one pass — an internal
 * copy with names masked and a shareable one with them tokenised. Absent, the
 * body is read as a single variant, which is what every existing client sends.
 */
export const exportOptionsSchema = variantSchema.extend({
  variants: z.array(variantSchema).min(1).max(MAX_VARIANTS).optional(),
})

export type ExportOptions = z.infer<typeof exportOptionsSchema>
