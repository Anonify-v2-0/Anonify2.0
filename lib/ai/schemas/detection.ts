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

/** The scale of every image coordinate: 1000 is the full width or height. */
export const IMAGE_GRID = 1000

const gridCoordinate = z.number().int().min(0).max(IMAGE_GRID)

export const imageAnalysisSchema = z.object({
  imageClass: z.enum(["document", "photograph", "mixed"]),
  regions: z
    .array(
      z.object({
        kind: z.enum(["face", "sensitive-text", "identifying-object"]),
        category,
        confidence: z.number().min(0).max(1),
        // Unbounded here and cut to 200 characters in analyzeImageRegions: a
        // local model's grammar enforces the shape of the JSON but not string
        // lengths, and a region is not worth discarding for a long sentence.
        reason: z.string().describe("One short sentence, under 200 characters"),
        // On a 0-1000 grid, whole numbers only. It is the convention vision
        // models such as Qwen3-VL and Gemini are trained to answer in, so they
        // answer in it unprompted, and the integer type is what keeps a model
        // answering in 0-1 fractions from being read as a speck in the corner:
        // 0.4 fails the type instead. See lib/ai/prompts/analyze-image.ts.
        x: gridCoordinate.describe("Left edge, 0-1000 across the image width"),
        y: gridCoordinate.describe("Top edge, 0-1000 down the image height"),
        width: gridCoordinate.describe("0-1000 of the image width"),
        height: gridCoordinate.describe("0-1000 of the image height"),
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
