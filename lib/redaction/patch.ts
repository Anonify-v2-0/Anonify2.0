import { z } from "zod"

import { REDACTION_METHODS, REDACTION_STATUSES } from "@/types/redaction"

/**
 * Accept, reject, or change what accepting does.
 *
 * Both fields are optional and either can arrive alone: setting a method is
 * not a decision about whether to redact, and a reviewer who picks
 * "pseudonymize" on a suggestion they have not accepted yet has said something
 * meaningful about what should happen if they do.
 *
 * Nothing is validated against the category here. Whether a method is allowed
 * is decided in lib/redaction/methods.ts, and asked again at export time
 * against the redaction as it stands then — so a stored method that stops
 * being defensible resolves to a mask rather than being honoured because it
 * was legal when it was saved.
 */
const decisionSchema = z
  .object({
    ids: z.array(z.string().min(1)).min(1).max(2000),
    status: z.enum(REDACTION_STATUSES).optional(),
    method: z.enum(REDACTION_METHODS).optional(),
  })
  // Strict, so a box sent alongside a status is refused rather than dropped
  // while the status goes through.
  .strict()
  .refine(
    (value) => value.status !== undefined || value.method !== undefined,
    "Nothing to change"
  )

/**
 * A drawn region moved or resized. One region at a time, because each has its
 * own box, and never together with a status or a method: moving a box is not
 * accepting it, and a request that tried to do both is refused whole.
 */
const geometrySchema = z
  .object({
    ids: z.array(z.string().min(1)).length(1),
    boundingBox: z.object({
      x: z.number().min(0),
      y: z.number().min(0),
      width: z.number().positive(),
      height: z.number().positive(),
    }),
  })
  .strict()

/** The body of `PATCH /api/documents/:id/redactions`. */
export const redactionPatchSchema = z.union([geometrySchema, decisionSchema])
