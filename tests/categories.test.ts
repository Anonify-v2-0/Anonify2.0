import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import { PROMPT_VERSION, SYSTEM_PROMPT } from "@/benchmarks/corpus/lib/prompt"
import {
  CATEGORIES as CORPUS_CATEGORIES,
  type LabelledDocument,
} from "@/benchmarks/corpus/lib/types"
import { aggregate, scoreDocument } from "@/benchmarks/lib/scoring"
import { ANALYZE_SPREADSHEET_SYSTEM } from "@/lib/ai/prompts/analyze-spreadsheet"
import { DETECT_PII_SYSTEM, detectPiiPrompt } from "@/lib/ai/prompts/detect-pii"
import {
  CATEGORY_DEFINITIONS,
  categoryGuide,
  categoryMeaning,
} from "@/lib/redaction/categories"
import { categoriesAllowing } from "@/lib/redaction/methods"
import { presetById } from "@/lib/redaction/presets"
import { REDACTION_CATEGORIES } from "@/types/redaction"

/**
 * One set of category definitions, read by the detection prompt and by the
 * corpus generator (#197).
 *
 * The first model benchmark lost two thirds of its precision to a
 * disagreement nobody had written down: the model was handed category names
 * with no meanings and asked for "health or financial facts", so it filed
 * symptoms under `confidential` and every invoice line under `financial`,
 * while the corpus, generated from its own definitions, labelled neither.
 */

describe("the category definitions", () => {
  it("define every category", () => {
    for (const category of REDACTION_CATEGORIES) {
      expect(CATEGORY_DEFINITIONS[category].meaning.length).toBeGreaterThan(10)
    }
  })

  it("leave the corpus prompt exactly as the corpus was generated with", () => {
    // The corpus prompt is built from the definitions now. Its text is what
    // PROMPT_VERSION 1 means, so a change to it is a new version and a
    // corpus to regenerate, never a quiet edit here.
    expect(PROMPT_VERSION).toBe("1")
    expect(createHash("sha256").update(SYSTEM_PROMPT).digest("hex")).toBe(
      "f4b8ee1c7d8be3462178e51aa2372143b9081e95bcf8b60001c7536fc26421b4"
    )
    for (const category of CORPUS_CATEGORIES) {
      expect(SYSTEM_PROMPT).toContain(CATEGORY_DEFINITIONS[category].meaning)
    }
  })

  it("lay out each one with what it is not", () => {
    expect(categoryGuide(["financial"])).toBe(
      `- financial: ${CATEGORY_DEFINITIONS.financial.meaning}. Not ${CATEGORY_DEFINITIONS.financial.not}.`
    )
    expect(categoryGuide(["email"])).toBe("- email: an email address.")
    // The corpus lays `other` out over two lines; a prompt reads it as one.
    expect(categoryMeaning("other")).not.toContain("\n")
  })
})

describe("the detection prompt", () => {
  it("defines every text category, and what each one is not", () => {
    for (const category of REDACTION_CATEGORIES) {
      if (category === "face") continue
      expect(DETECT_PII_SYSTEM).toContain(
        `- ${category}: ${categoryMeaning(category)}`
      )
      const { not } = CATEGORY_DEFINITIONS[category]
      if (not) expect(DETECT_PII_SYSTEM).toContain(`Not ${not}.`)
    }
    // Faces are the vision pass's; the text pass cannot see one.
    expect(DETECT_PII_SYSTEM).not.toContain("- face:")
  })

  it("no longer asks for every health or financial fact", () => {
    const prompt = detectPiiPrompt({ content: "…" })
    expect(prompt).not.toContain("health or financial facts")
    expect(prompt).toContain("a named person's health")
    expect(prompt).toContain("what a named person earns, owes or holds")
  })

  it("files a person's health as health, in the spreadsheet pass too", () => {
    expect(DETECT_PII_SYSTEM).toContain(
      "Not a person's health (that is health)"
    )
    expect(ANALYZE_SPREADSHEET_SYSTEM).toContain("is health, not confidential")
  })

  it("asks for health when the reviewer chose everything", () => {
    expect(presetById("everything")?.looksFor.join("\n")).toContain("health")
  })
})

describe("the health category", () => {
  it("can only be masked", () => {
    // A stand-in for a diagnosis still says something about the person.
    for (const method of ["pseudonymize", "tokenize", "encrypt"] as const) {
      expect(categoriesAllowing(method)).not.toHaveProperty("health")
    }
    expect(categoriesAllowing("mask")).toHaveProperty("health", "mask")
  })
})

describe("scoring a category the corpus does not label", () => {
  const document = {
    id: "syn-v1-0001",
    docType: "medical referral",
    text: "Priya Raman has type 2 diabetes.",
    spans: [{ start: 0, end: 11, category: "person", value: "Priya Raman" }],
    negatives: [],
  } as unknown as LabelledDocument

  it("leaves it out of precision, and counts it on its own", () => {
    const quality = aggregate([
      scoreDocument(document, [
        { start: 0, end: 11, category: "person" },
        { start: 16, end: 31, category: "health" },
      ]),
    ])
    expect(quality.precision).toBe(1)
    expect(quality.falsePositives).toBe(0)
    expect(quality.detections).toBe(1)
    expect(quality.unscored).toEqual({ health: 1 })
  })

  it("does not let it cover a label either", () => {
    const quality = aggregate([
      scoreDocument(document, [{ start: 0, end: 31, category: "health" }]),
    ])
    expect(quality.recall).toBe(0)
  })
})
