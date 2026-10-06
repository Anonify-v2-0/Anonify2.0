import { createHash } from "node:crypto"

/**
 * What a model was asked, as a hash (#204).
 *
 * A results file records the corpus it was measured on. It also has to record
 * what the model was told, because a change to the category definitions or
 * to a prompt changes the answers as surely as a change to the labels does:
 * the first published results predated #199 and nothing showed they were
 * stale.
 *
 * Each part is hashed from what the model actually reads: the definitions,
 * and the detection and verification prompts with their response schemas,
 * rendered for fixed inputs in English and in a language of its own. An edit
 * to a comment changes nothing here; an edit to a word the model sees does.
 */

export type Fingerprint = {
  categories: string
  detect: string
  verify: string
}

function hash(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16)}`
}

export async function promptFingerprint(): Promise<Fingerprint> {
  const { z } = await import("zod")
  const { CATEGORY_DEFINITIONS } = await import("@/lib/redaction/categories")
  const { DETECT_PII_SYSTEM, detectPiiPrompt } =
    await import("@/lib/ai/prompts/detect-pii")
  const { VERIFY_SYSTEM, verifyDetectionPrompt } =
    await import("@/lib/ai/prompts/verify-detection")
  const { detectionResultSchema, verificationSchema } =
    await import("@/lib/ai/schemas/detection")

  const languages = [undefined, "de"] as const
  return {
    categories: hash(CATEGORY_DEFINITIONS),
    detect: hash({
      system: DETECT_PII_SYSTEM,
      prompts: languages.map((language) =>
        detectPiiPrompt({
          documentType: "invoice",
          language,
          content: "Call Priya Raman on 555-0142.",
          alreadyFound: ["555-0142"],
          lookFor: ["names"],
        })
      ),
      schema: z.toJSONSchema(detectionResultSchema),
    }),
    verify: hash({
      system: VERIFY_SYSTEM,
      prompts: languages.map((language) =>
        verifyDetectionPrompt(
          [
            {
              index: 0,
              text: "555-0142",
              category: "phone",
              context: "Call Priya Raman on 555-0142.",
            },
          ],
          language
        )
      ),
      schema: z.toJSONSchema(verificationSchema),
    }),
  }
}

/** The parts of `measured` that differ from `current`; empty when it is current. */
export function staleParts(
  measured: Fingerprint | undefined,
  current: Fingerprint
): string[] {
  if (!measured) return ["unrecorded"]
  return (Object.keys(current) as Array<keyof Fingerprint>).filter(
    (key) => measured[key] !== current[key]
  )
}
