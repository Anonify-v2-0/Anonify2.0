import { describe, expect, it } from "vitest"

import { DETECTORS, detectPatterns } from "@/lib/redaction/detectors"
import {
  categoryAllowed,
  DEFAULT_PRESET_ID,
  isPresetId,
  parsePresets,
  presetById,
  PRESET_DISCLAIMER,
  PRESETS,
} from "@/lib/redaction/presets"
import { buildExportReport } from "@/lib/redaction/report"
import { REDACTION_CATEGORIES } from "@/types/redaction"

/**
 * The naming rule is the feature.
 *
 * A preset that turns on the right detectors and is called "HIPAA" is worse
 * than no preset at all — it converts a tool that helps into one that misleads,
 * on the question where being misled is most expensive. So the tests that
 * matter here are the ones about what a preset may be called.
 */

function fileWith(preset: Record<string, unknown>) {
  return {
    version: 1,
    presets: [
      {
        id: "example",
        label: "Example",
        summary: "An example.",
        looksFor: ["Something"],
        detectors: null,
        categories: null,
        ...preset,
      },
    ],
  }
}

describe("preset naming", () => {
  it("refuses a preset named after a regulation", () => {
    for (const label of [
      "HIPAA",
      "GDPR essentials",
      "PCI DSS",
      "SOC 2 ready",
    ]) {
      expect(() => parsePresets(fileWith({ label }))).toThrow()
    }
  })

  it("refuses a preset that claims an outcome rather than a search", () => {
    expect(() =>
      parsePresets(fileWith({ summary: "Makes a document compliant." }))
    ).toThrow()
    expect(() =>
      parsePresets(fileWith({ looksFor: ["Everything, guaranteed"] }))
    ).toThrow()
    expect(() => parsePresets(fileWith({ id: "gdpr-basic" }))).toThrow()
  })

  it("accepts a preset named for what it looks for", () => {
    const presets = parsePresets(
      fileWith({
        id: "names-and-contact-details",
        label: "Names and contact details",
        summary: "The things that identify a person directly.",
        looksFor: ["Email addresses", "Names of people"],
      })
    )
    expect(presets).toHaveLength(1)
  })

  it("states plainly, where the choice is made, that it is not a guarantee", () => {
    // The wording can change; what it has to keep saying cannot.
    expect(PRESET_DISCLAIMER).toMatch(/starting point/i)
    expect(PRESET_DISCLAIMER).toMatch(/not what you are responsible for/i)
  })
})

describe("shipped presets", () => {
  it("names only detectors that exist", () => {
    const known = new Set(DETECTORS.map((detector) => detector.id))
    for (const preset of PRESETS) {
      for (const id of preset.detectors ?? []) {
        expect(known, `${preset.id} names an unknown detector`).toContain(id)
      }
    }
  })

  it("names only categories the redaction model knows", () => {
    for (const preset of PRESETS) {
      for (const category of preset.categories ?? []) {
        expect(
          REDACTION_CATEGORIES as readonly string[],
          `${preset.id} names an unknown category`
        ).toContain(category)
      }
    }
  })

  it("gives every detector a stable, unique id", () => {
    const ids = DETECTORS.map((detector) => detector.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("keeps a default that narrows nothing", () => {
    const preset = presetById(DEFAULT_PRESET_ID)
    expect(preset).not.toBeNull()
    expect(preset?.detectors).toBeNull()
    expect(preset?.categories).toBeNull()
    expect(isPresetId("something-invented")).toBe(false)
  })
})

describe("what a preset changes", () => {
  const text =
    "Contact john@example.com or call 415 555 0132. Card 4111 1111 1111 1111."

  it("runs every detector when nothing is chosen", () => {
    const categories = detectPatterns(text).map(
      (detection) => detection.category
    )
    expect(categories).toContain("email")
    expect(categories).toContain("financial")
  })

  it("runs only the detectors the preset names", () => {
    const preset = presetById("payment-and-account-numbers")
    const categories = detectPatterns(text, {
      detectors: preset?.detectors,
    }).map((detection) => detection.category)

    expect(categories).toContain("financial")
    expect(categories).not.toContain("email")
    expect(categories).not.toContain("phone")
  })

  it("holds the model to the same categories as the patterns", () => {
    const preset = presetById("credentials-and-keys")
    expect(categoryAllowed(preset, "api-key")).toBe(true)
    expect(categoryAllowed(preset, "person")).toBe(false)
    // No preset means no narrowing, which is the safe direction.
    expect(categoryAllowed(null, "person")).toBe(true)
  })

  it("records in the export report that the search was narrowed", () => {
    const report = buildExportReport({
      document: {
        id: "doc_1",
        kind: "pdf",
        sizeBytes: 1024,
        pageCount: 1,
        sourceChecksum: "a".repeat(64),
      },
      artifact: {
        checksum: "b".repeat(64),
        sizeBytes: 512,
        mimeType: "application/pdf",
        extension: "pdf",
      },
      options: { addLabels: false, sanitizeMetadata: true },
      redactions: [],
      verification: { passed: true, checkedValues: 0 },
      preset: presetById("credentials-and-keys"),
    })

    // Without this, a short list of removals reads as a clean document.
    expect(report.lookedFor.presetId).toBe("credentials-and-keys")
    expect(report.notes.join(" ")).toContain("is not evidence it is absent")
  })
})
