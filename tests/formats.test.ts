import { describe, expect, it } from "vitest"

import {
  ACCEPTED_EXTENSIONS,
  ACCEPTED_MIME_TYPES,
  FORMAT_LIST,
  FORMATS,
  isPureContainer,
  kindForExtension,
  kindForMimeType,
  outputTypeFor,
  quotaKindFor,
  supportedFormatsSentence,
} from "@/lib/documents/formats"
import { USAGE_KINDS } from "@/lib/security/quota-config"
import { DOCUMENT_KINDS } from "@/types/document"

/**
 * The register is only worth having if it is the whole truth about a format.
 * These are the invariants that used to be maintained by remembering to edit
 * eight files: nothing claimed twice, nothing missing, and every derived list
 * actually derived.
 */

describe("the format register", () => {
  it("has an entry for every document kind", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(FORMATS[kind]).toBeDefined()
      expect(FORMATS[kind].kind).toBe(kind)
    }
    expect(FORMAT_LIST).toHaveLength(DOCUMENT_KINDS.length)
  })

  it("gives every format a canonical type it actually accepts", () => {
    for (const format of FORMAT_LIST) {
      expect(format.mimeTypes).toContain(format.mimeType)
      expect(format.extensions).toContain(format.extension)
      expect(format.label.length).toBeGreaterThan(0)
      expect(format.quotaUnit.length).toBeGreaterThan(0)
    }
  })

  it("never lets two formats claim the same extension or MIME type", () => {
    const extensions = FORMAT_LIST.flatMap((format) => format.extensions)
    const mimeTypes = FORMAT_LIST.flatMap((format) => format.mimeTypes)

    expect(new Set(extensions).size).toBe(extensions.length)
    expect(new Set(mimeTypes).size).toBe(mimeTypes.length)
  })

  it("writes extensions without a dot and in lowercase", () => {
    for (const format of FORMAT_LIST) {
      for (const extension of format.extensions) {
        expect(extension).toBe(extension.toLowerCase())
        expect(extension.startsWith(".")).toBe(false)
      }
    }
  })

  it("charges every format against a quota that exists", () => {
    for (const format of FORMAT_LIST) {
      expect(USAGE_KINDS).toContain(format.quota)
      expect(quotaKindFor(format.kind)).toBe(format.quota)
    }
  })

  it("gives a container nothing to extract and nothing to export", () => {
    // The one shape that is allowed to be neither: a mailbox is not a document
    // somebody reviews, it is the batch its messages arrived in. Asserting
    // both halves stops a format being registered as half a container, which
    // would reach an extractor that does not exist.
    for (const format of FORMAT_LIST) {
      if (format.extractable) continue
      expect(format.exportable).toBe(false)
      expect(isPureContainer(format.kind)).toBe(true)
    }
  })

  it("has an exporter for everything it will extract", () => {
    // A format that can be reviewed but not written back is a document the
    // user can redact and never get out, which is worse than not supporting it.
    for (const format of FORMAT_LIST) {
      if (format.extractable) expect(format.exportable).toBe(true)
    }
  })

  describe("the derived lists", () => {
    it("offers every registered extension to the file picker", () => {
      for (const format of FORMAT_LIST) {
        for (const extension of format.extensions) {
          expect(ACCEPTED_EXTENSIONS).toContain(`.${extension}`)
        }
      }
      expect(ACCEPTED_EXTENSIONS.every((entry) => entry.startsWith("."))).toBe(
        true
      )
    })

    it("maps every registered MIME type back to its kind", () => {
      for (const format of FORMAT_LIST) {
        for (const mimeType of format.mimeTypes) {
          expect(ACCEPTED_MIME_TYPES[mimeType]).toBe(format.kind)
          expect(kindForMimeType(mimeType)).toBe(format.kind)
        }
      }
    })

    it("resolves an extension however it was written", () => {
      expect(kindForExtension("pdf")).toBe("pdf")
      expect(kindForExtension(".PDF")).toBe("pdf")
      expect(kindForExtension("JPEG")).toBe("image")
      expect(kindForExtension("exe")).toBeUndefined()
      expect(kindForExtension("")).toBeUndefined()
    })

    it("names an output type for every kind", () => {
      for (const kind of DOCUMENT_KINDS) {
        const output = outputTypeFor(kind)
        expect(output.extension.length).toBeGreaterThan(0)
        expect(output.mimeType).toContain("/")
      }
    })

    it("names every format in the sentence shown to a user", () => {
      const sentence = supportedFormatsSentence()
      for (const format of FORMAT_LIST) {
        expect(sentence).toContain(format.label)
      }
    })
  })
})
