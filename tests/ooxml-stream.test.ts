import { unzipSync, zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { extractDocx, extractDocxPackage } from "@/lib/documents/docx/extract"
import { openPackageFromArchive } from "@/lib/documents/ooxml/package"
import { openZip } from "@/lib/documents/ooxml/zip"
import { extractPptx, extractPptxPackage } from "@/lib/documents/pptx/extract"
import { bufferRangeSource } from "@/lib/storage/range-source"

import { makeDocxFixture, makeLongDocxFixture } from "./fixtures"
import { makePptxFixture } from "./pptx-fixtures"

/**
 * Word documents and decks, read by ranges.
 *
 * Only the XML parts are inflated and held; pictures and everything else are
 * inflated and let go. The extraction over that package has to be exactly the
 * extraction over the whole one, and a part that was let go must not be
 * readable by accident.
 */

async function rangedPackage(bytes: Uint8Array) {
  return openPackageFromArchive(await openZip(bufferRangeSource(bytes), 1024))
}

/** A megabyte of "photograph" beside the text, which is the usual shape. */
function withMedia(bytes: Uint8Array, folder: string): Uint8Array {
  const noise = new Uint8Array(1 << 20)
  for (let at = 0; at < noise.length; at++) noise[at] = (at * 2654435761) >>> 24
  return zipSync({ ...unzipSync(bytes), [`${folder}/media/image1.png`]: noise })
}

describe("a Word document read by ranges", () => {
  it("extracts exactly what the whole package extracts", async () => {
    for (const bytes of [
      await makeDocxFixture(),
      await makeLongDocxFixture(200, 50),
      withMedia(await makeDocxFixture(), "word"),
    ]) {
      expect(extractDocxPackage("d", await rangedPackage(bytes))).toEqual(
        extractDocx("d", bytes)
      )
    }
  })

  it("never holds the pictures, and refuses to hand one out", async () => {
    const pkg = await rangedPackage(withMedia(await makeDocxFixture(), "word"))

    expect(Object.keys(pkg.files)).toContain("word/media/image1.png")
    expect(() => pkg.files["word/media/image1.png"]).toThrow(/XML parts only/)
    expect(pkg.files["word/document.xml"]).toBeInstanceOf(Uint8Array)
  })

  it("keeps the parts in the order unzipSync lists them", async () => {
    const bytes = withMedia(await makeDocxFixture(), "word")
    expect(Object.keys((await rangedPackage(bytes)).files)).toEqual(
      Object.keys(unzipSync(bytes))
    )
  })
})

describe("a deck read by ranges", () => {
  it("extracts exactly what the whole package extracts", async () => {
    for (const bytes of [
      makePptxFixture(),
      makePptxFixture({ reversed: true }),
      withMedia(makePptxFixture(), "ppt"),
    ]) {
      expect(extractPptxPackage("p", await rangedPackage(bytes))).toEqual(
        extractPptx("p", bytes)
      )
    }
  })

  it("is refused where the whole package is refused", async () => {
    const files = unzipSync(makePptxFixture())
    delete files["ppt/presentation.xml"]
    const bytes = zipSync(files)

    expect(() => extractPptx("p", bytes)).toThrow(/presentation.xml is missing/)
    const pkg = await rangedPackage(bytes)
    expect(() => extractPptxPackage("p", pkg)).toThrow(/presentation.xml is missing/)
  })
})
