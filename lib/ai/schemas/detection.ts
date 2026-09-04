import { z } from "zod"

import { REDACTION_CATEGORIES } from "@/types/redaction"

/**
 * Structured output contracts.
 *
 * The model returns objects that validate against these schemas or the result
 * is discarded — no parsing of prose, no coaxing meaning out of free text. A
 * detection that does not validate is a detection that never reaches the user.
 */

const category = z
  .enum(REDACTION_CATEGORIES)
  .describe("The kind of sensitive information this is")

export const detectionSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(300)
    .describe("The exact substring from the supplied content, copied verbatim"),
  category,
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How certain you are that this is sensitive in this context"),
  reason: z
    .string()
    .max(200)
    .describe("One short sentence explaining why this is sensitive"),
  global: z
    .boolean()
    .describe(
      "True when every occurrence of this exact value should be redacted"
    ),
})

export const detectionResultSchema = z.object({
  detections: z.array(detectionSchema).max(200),
})

export type ModelDetection = z.infer<typeof detectionSchema>

export const classificationSchema = z.object({
  documentType: z
    .string()
    .max(60)
    .describe("A short label, e.g. invoice, contract, medical record"),
  language: z.string().max(40).describe("Primary language of the content"),
  sensitivityDensity: z
    .enum(["none", "low", "medium", "high"])
    .describe("How much sensitive information this document likely contains"),
  notes: z.string().max(300).describe("Anything the reviewer should know"),
})

export type Classification = z.infer<typeof classificationSchema>

export const columnAnalysisSchema = z.object({
  columns: z
    .array(
      z.object({
        index: z.number().int().min(1).describe("1-based column number"),
        header: z.string().max(120),
        category,
        confidence: z.number().min(0).max(1),
        sensitive: z
          .boolean()
          .describe("True when the whole column should be treated as sensitive"),
        reason: z.string().max(200),
      })
    )
    .max(200),
})

export type ColumnAnalysis = z.infer<typeof columnAnalysisSchema>

export const imageAnalysisSchema = z.object({
  imageClass: z.enum(["document", "photograph", "mixed"]),
  regions: z
    .array(
      z.object({
        kind: z.enum(["face", "sensitive-text", "identifying-object"]),
        category,
        confidence: z.number().min(0).max(1),
        reason: z.string().max(200),
        // Normalized so the model never has to reason about pixel dimensions.
        x: z.number().min(0).max(1).describe("Left edge, 0-1 of image width"),
        y: z.number().min(0).max(1).describe("Top edge, 0-1 of image height"),
        width: z.number().min(0).max(1),
        height: z.number().min(0).max(1),
      })
    )
    .max(60),
})

export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>

export const verificationSchema = z.object({
  verdicts: z
    .array(
      z.object({
        index: z
          .number()
          .int()
          .min(0)
          .describe("Position of the candidate in the supplied list"),
        sensitive: z.boolean(),
        confidence: z.number().min(0).max(1),
        reason: z.string().max(200),
      })
    )
    .max(200),
})

export type Verification = z.infer<typeof verificationSchema>
