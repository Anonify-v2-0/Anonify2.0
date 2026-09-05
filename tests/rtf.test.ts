import { describe, expect, it } from "vitest"

import { extractRtf } from "@/lib/documents/rtf/extract"
import {
  decodeRtf,
  looksLikeRtf,
  parseRtf,
  RtfParseError,
} from "@/lib/documents/rtf/parse"
import { redactRtf, sourceCutsFor } from "@/lib/documents/rtf/redact"
import { buildTextPlan } from "@/lib/redaction/apply"
import { detectPatterns } from "@/lib/redaction/detectors"
import { verifyExport } from "@/lib/redaction/validation"
import type { Redaction } from "@/types/redaction"

import { SENSITIVE } from "./fixtures"

/**
 * RTF.
 *
 * Everything here exists because visible text in RTF is not contiguous in the
 * file. A word processor splits a value at every formatting change, writes
 * accented characters as escapes, and puts control words between the halves of
 * a word. A search over the source finds none of that, and a replacement made
 * against the source is as likely to delete half a control word as a
 * character — which produces a file that no longer opens.
 *
 * So the fixtures below are deliberately hostile in exactly those ways, and
 * every assertion is made twice: the value is gone, *and* the output still
 * parses as RTF.
 */

function bytes(source: string): Uint8Array {
  return new Uint8Array(Buffer.from(source, "latin1"))
}

function sourceOf(output: Uint8Array): string {
  return decodeRtf(output)
}

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

/** A minimal but real RTF document around the given body. */
function rtf(body: string): string {
  return (
    "{\\rtf1\\ansi\\ansicpg1252\\deff0" +
    "{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}" +
    "{\\colortbl ;\\red0\\green0\\blue0;}" +
    `{\\*\\generator Riched20 10.0}\\pard\\f0\\fs22 ${body}\\par}`
  )
}

function redactionFor(
  model: ReturnType<typeof extractRtf>["document"],
  value: string
): Redaction {
  for (const page of model.pages) {
    const index = page.text.indexOf(value)
    if (index === -1) continue
    return {
      id: `red-${value}`,
      documentId: "doc",
      type: "text",
      source: "ai",
      category: "email",
      status: "accepted",
      page: page.number,
      text: value,
      start: index,
      end: index + value.length,
    }
  }
  throw new Error(`${value} is not in the extracted text`)
}

describe("recognising RTF", () => {
  it("reads the header from the bytes", () => {
    expect(looksLikeRtf(bytes(rtf("hello")))).toBe(true)
    expect(looksLikeRtf(bytes("not rtf at all"))).toBe(false)
  })

  it("refuses a file without the header rather than parsing rubbish", () => {
    expect(() => parseRtf("plain text")).toThrow(RtfParseError)
  })

  it("refuses a pathologically nested file", () => {
    const deep = `{\\rtf1${"{".repeat(200)}x${"}".repeat(200)}}`
    expect(() => parseRtf(deep)).toThrow(RtfParseError)
  })
})

describe("parsing RTF into visible text", () => {
  it("ignores the font, colour and generator tables", () => {
    const { text } = parseRtf(rtf("Hello"))

    expect(text).toContain("Hello")
    expect(text).not.toContain("Times New Roman")
    expect(text).not.toContain("Riched20")
    expect(text).not.toContain("froman")
  })

  it("joins text a formatting change split in half", () => {
    // This is the case the whole pipeline exists for: the address is one value
    // to a reader and two runs in the file.
    const { text } = parseRtf(
      rtf("Email: john{\\b @example}\\b0 .com and more")
    )
    expect(text).toContain("john@example.com")
  })

  it("decodes hex escapes through Windows-1252", () => {
    const { text } = parseRtf(rtf("caf\\'e9 and a \\'92quote\\'92"))
    expect(text).toContain("café")
    expect(text).toContain("’quote’")
  })

  it("decodes unicode escapes and swallows their fallback characters", () => {
    const { text } = parseRtf(rtf("Na\\u239?ve and \\u8212? dash"))
    expect(text).toContain("Naïve")
    expect(text).toContain("— dash")
    expect(text).not.toContain("?")
  })

  it("honours a multi-character fallback count", () => {
    const { text } = parseRtf(rtf("\\uc2 x\\u233?? y"))
    expect(text).toContain("xé y")
  })

  it("turns breaks into the characters a reader sees", () => {
    // The space after a control word is its delimiter, not content — which is
    // exactly the kind of detail a hand-rolled scanner gets wrong and then
    // offsets everything downstream by one.
    const { text } = parseRtf(rtf("one\\par two\\line three\\tab four"))
    expect(text).toBe("one\ntwo\nthree\tfour\n")
  })

  it("keeps escaped braces and backslashes as literal characters", () => {
    const { text } = parseRtf(rtf("a \\{brace\\} and a \\\\slash"))
    expect(text).toContain("a {brace} and a \\slash")
  })

  it("skips binary data without reading its bytes as markup", () => {
    const binary = "{\\*\\pict\\wmetafile8\\bin4 }{}}\\par}"
    const { text } = parseRtf(`{\\rtf1\\ansi visible ${binary}`)
    expect(text).toContain("visible")
  })

  describe("the map back to the source", () => {
    it("points every atom at the bytes that produced it", () => {
      const source = rtf("Email: john{\\b @example}.com")
      const { text, atoms } = parseRtf(source)

      for (const atom of atoms) {
        expect(atom.textEnd - atom.textStart).toBeGreaterThan(0)
        expect(atom.end).toBeGreaterThan(atom.start)
        if (atom.kind === "literal") {
          // A literal atom's bytes are its characters, which is what makes a
          // partial cut sliceable.
          expect(source.slice(atom.start, atom.end)).toBe(
            text.slice(atom.textStart, atom.textEnd)
          )
        }
      }
    })

    it("never proposes cutting a paragraph mark", () => {
      const source = rtf("one\\par two")
      const { text, atoms } = parseRtf(source)

      const cuts = sourceCutsFor(atoms, [{ start: 0, end: text.length }])
      const removed = cuts
        .flatMap((cut) => cut.ranges)
        .map((range) => source.slice(range.start, range.end))
        .join("")

      expect(removed).not.toContain("\\par")
    })
  })
})

describe("extracting an RTF document", () => {
  it("produces reviewable pages whose spans carry source offsets", () => {
    const source = rtf(
      `Name: ${SENSITIVE.person}\\par Email: ${SENSITIVE.email}\\par Phone: ${SENSITIVE.phone}`
    )
    const { document, text } = extractRtf("doc", bytes(source))

    expect(document.kind).toBe("rtf")
    expect(document.pages.length).toBeGreaterThan(0)

    const page = document.pages[0]
    expect(page.text).toContain(SENSITIVE.email)

    for (const span of page.spans) {
      const offset = Number(span.id.split("#")[1])
      expect(text.slice(offset, offset + span.text.length)).toBe(span.text)
    }
  })
})

describe("redacting RTF", () => {
  it("removes a value and leaves the document openable", () => {
    const source = rtf(`Email: ${SENSITIVE.email} end`)
    const { document } = extractRtf("doc", bytes(source))
    const redaction = redactionFor(document, SENSITIVE.email)

    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redaction], OPTIONS)
    )

    expect(sourceOf(output)).not.toContain(SENSITIVE.email)
    // Still RTF: the header, the tables and the closing brace are all there,
    // and it re-parses to the same text minus the value.
    const reparsed = parseRtf(sourceOf(output))
    expect(reparsed.text).toContain("Email: ")
    expect(reparsed.text).toContain("end")
    expect(sourceOf(output).startsWith("{\\rtf1")).toBe(true)
    expect(sourceOf(output).endsWith("}")).toBe(true)
  })

  it("removes a value split across formatting groups", () => {
    // The adversarial case. The email is four fragments in the file, none of
    // which is the whole value, and the source never contains the string.
    const source = rtf(
      "Contact: jo{\\b hn}@ex{\\i amp}le{\\b\\i .com} — write to them"
    )
    const { document, text } = extractRtf("doc", bytes(source))

    expect(text).toContain("john@example.com")
    expect(source).not.toContain("john@example.com")

    const redaction = redactionFor(document, "john@example.com")
    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redaction], OPTIONS)
    )

    const reparsed = parseRtf(sourceOf(output))
    expect(reparsed.text).not.toContain("john@example.com")
    expect(reparsed.text).toContain("Contact: ")
    expect(reparsed.text).toContain("write to them")
    // The formatting groups themselves survive: only characters were removed.
    expect(sourceOf(output)).toContain("{\\b")
  })

  it("removes a value written with escapes", () => {
    const source = rtf("Name: Ren\\'e9 Fran\\u231?ois here")
    const { document, text } = extractRtf("doc", bytes(source))

    expect(text).toContain("René François")

    const redaction = redactionFor(document, "René François")
    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redaction], OPTIONS)
    )

    const reparsed = parseRtf(sourceOf(output))
    expect(reparsed.text).not.toContain("René")
    expect(reparsed.text).not.toContain("François")
    expect(reparsed.text).toContain("here")
    // The escapes went whole; no half-escape was left behind to corrupt the
    // characters after it.
    expect(sourceOf(output)).not.toContain("\\'e9")
    expect(sourceOf(output)).not.toContain("\\u231")
  })

  it("removes every occurrence, including one nobody reviewed", () => {
    const source = rtf(
      `Primary: ${SENSITIVE.email}\\par Copied to {\\b ${SENSITIVE.email}} as well`
    )
    const { document } = extractRtf("doc", bytes(source))
    const redaction = redactionFor(document, SENSITIVE.email)

    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redaction], OPTIONS)
    )

    expect(parseRtf(sourceOf(output)).text).not.toContain(SENSITIVE.email)
  })

  it("keeps paragraph structure across a redaction", () => {
    const source = rtf(`one\\par ${SENSITIVE.email}\\par three`)
    const { document } = extractRtf("doc", bytes(source))
    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redactionFor(document, SENSITIVE.email)], OPTIONS)
    )

    const reparsed = parseRtf(sourceOf(output))
    // Three paragraphs before, three after: the value went, the shape did not.
    expect(reparsed.text.split("\n").length).toBe(4)
    expect(reparsed.text).toContain("one")
    expect(reparsed.text).toContain("three")
  })

  it("writes one marker for a value scattered across runs", () => {
    const source = rtf("Contact: jo{\\b hn}@ex{\\i amp}le{\\b .com} end")
    const { document } = extractRtf("doc", bytes(source))
    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [redactionFor(document, "john@example.com")], {
        ...OPTIONS,
        addLabels: true,
      })
    )

    const reparsed = parseRtf(sourceOf(output))
    expect(reparsed.text.match(/\[REDACTED\]/g)).toHaveLength(1)
    expect(reparsed.text).not.toContain("john@example.com")
  })

  it("ignores a rejected suggestion", () => {
    const source = rtf(`Email: ${SENSITIVE.email}`)
    const { document } = extractRtf("doc", bytes(source))
    const rejected: Redaction = {
      ...redactionFor(document, SENSITIVE.email),
      status: "rejected",
    }

    const output = redactRtf(
      bytes(source),
      buildTextPlan(document, [rejected], OPTIONS)
    )
    expect(parseRtf(sourceOf(output)).text).toContain(SENSITIVE.email)
  })

  describe("verification", () => {
    it("passes only after the value is gone from the reparsed document", async () => {
      const source = rtf(
        `Email: jo{\\b hn}@example.com and phone ${SENSITIVE.phone}`
      )
      const { document, text } = extractRtf("doc", bytes(source))

      const detections = detectPatterns(document.pages[0].text, { page: 1 })
      expect(detections.length).toBeGreaterThan(0)

      const redactions: Redaction[] = detections.map((detection, index) => ({
        id: `det-${index}`,
        documentId: "doc",
        type: "text",
        source: "ai",
        category: detection.category,
        status: "accepted",
        page: detection.page,
        text: detection.text,
        start: detection.start,
        end: detection.end,
      }))

      expect(text).toContain("john@example.com")

      const output = redactRtf(
        bytes(source),
        buildTextPlan(document, redactions, OPTIONS)
      )

      const report = await verifyExport("rtf", output, redactions)
      expect(report.passed).toBe(true)
      expect(report.checkedValues).toBeGreaterThan(0)

      const untouched = await verifyExport("rtf", bytes(source), redactions)
      expect(untouched.passed).toBe(false)
    })
  })
})
