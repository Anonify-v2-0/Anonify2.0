import { zipSync } from "fflate"

import { SENSITIVE } from "./fixtures"

/**
 * A deck, assembled part by part.
 *
 * Built by hand rather than by a library, for the same reason the email
 * fixtures are: the interesting cases are the ones a well-behaved writer never
 * produces. Text split across three runs because someone bolded one word in
 * the middle of an address; a client's name sitting only on the slide master;
 * a phone number in the speaker notes, which are shipped with the file and
 * shown to nobody.
 *
 * It is a real package — the parts, the relationships and the content types a
 * reader needs — so opening it, editing it and reopening it exercises the same
 * code path a PowerPoint export would.
 */

export const DECK = {
  person: SENSITIVE.person,
  email: SENSITIVE.email,
  phone: SENSITIVE.phone,
  client: "Northwind Traders",
  author: "Deck Author",
} as const

function encode(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "utf8"))
}

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** One `a:p` holding the given runs, each its own `a:r`. */
function paragraph(runs: string[]): string {
  const body = runs
    .map(
      (text) =>
        `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${text
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")}</a:t></a:r>`
    )
    .join("")
  return `<a:p>${body}</a:p>`
}

function shape(id: number, name: string, paragraphs: string[]): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr><p:ph type="body" idx="${id}"/></p:nvPr></p:nvSpPr>` +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`
  )
}

function slideXml(shapes: string[]): string {
  return (
    `${XML}<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr/></p:sld>`
  )
}

function notesXml(paragraphs: string[]): string {
  return (
    `${XML}<p:notes xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    shape(2, "Notes Placeholder", paragraphs) +
    `</p:spTree></p:cSld><p:clrMapOvr/></p:notes>`
  )
}

function templateXml(root: string, paragraphs: string[]): string {
  return (
    `${XML}<p:${root} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"` +
    (root === "sldLayout" ? ' type="obj" preserve="1"' : ' preserve="1"') +
    `><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    shape(2, "Placeholder", paragraphs) +
    `</p:spTree></p:cSld><p:clrMapOvr/>` +
    (root === "sldMaster"
      ? '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
      : "") +
    `</p:${root}>`
  )
}

function rels(entries: { id: string; type: string; target: string }[]): string {
  return (
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    entries
      .map(
        (entry) =>
          `<Relationship Id="${entry.id}" Type="${entry.type}" Target="${entry.target}"/>`
      )
      .join("") +
    `</Relationships>`
  )
}

const TYPE = {
  slide:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  notesSlide:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  slideLayout:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slideMaster:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  officeDocument:
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
}

export type PptxOptions = {
  /** Reverses the presentation order relative to the file numbering. */
  reversed?: boolean
}

export function makePptxFixture(options: PptxOptions = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {}

  // Slide one: ordinary text, plus an address split across three runs by a
  // formatting change in the middle of it.
  files["ppt/slides/slide1.xml"] = encode(
    slideXml([
      shape(2, "Title", [paragraph([`Account review for ${DECK.person}`])]),
      shape(3, "Body", [
        paragraph(["Contact: ", "jo", "hn@exa", "mple.com"]),
        paragraph([`Direct line ${DECK.phone}`]),
      ]),
    ])
  )

  // Slide two: the same person again, which is the duplicate case.
  files["ppt/slides/slide2.xml"] = encode(
    slideXml([
      shape(2, "Title", [paragraph(["Next steps"])]),
      shape(3, "Body", [paragraph([`Follow up with ${DECK.person}.`])]),
    ])
  )

  // Speaker notes: not projected, not printed, shipped with the file.
  files["ppt/notesSlides/notesSlide1.xml"] = encode(
    notesXml([
      paragraph([`Remember ${DECK.person} asked about the ${DECK.client} deal.`]),
      paragraph([`His mobile is ${DECK.phone}.`]),
    ])
  )

  // The template's own text, which no slide contains and every slide shows.
  files["ppt/slideLayouts/slideLayout1.xml"] = encode(
    templateXml("sldLayout", [paragraph([`Prepared for ${DECK.client}`])])
  )
  files["ppt/slideMasters/slideMaster1.xml"] = encode(
    templateXml("sldMaster", [paragraph([`${DECK.client} — confidential`])])
  )

  const order = options.reversed
    ? ["ppt/slides/slide2.xml", "ppt/slides/slide1.xml"]
    : ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]

  files["ppt/presentation.xml"] = encode(
    `${XML}<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
      `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
      `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
      `<p:sldIdLst>` +
      order
        .map(
          (_slide, index) =>
            `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`
        )
        .join("") +
      `</p:sldIdLst>` +
      `<p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/>` +
      `</p:presentation>`
  )

  files["ppt/_rels/presentation.xml.rels"] = encode(
    rels([
      {
        id: "rId1",
        type: TYPE.slideMaster,
        target: "slideMasters/slideMaster1.xml",
      },
      ...order.map((slide, index) => ({
        id: `rId${index + 2}`,
        type: TYPE.slide,
        target: slide.replace("ppt/", ""),
      })),
    ])
  )

  files["ppt/slides/_rels/slide1.xml.rels"] = encode(
    rels([
      {
        id: "rId1",
        type: TYPE.slideLayout,
        target: "../slideLayouts/slideLayout1.xml",
      },
      {
        id: "rId2",
        type: TYPE.notesSlide,
        target: "../notesSlides/notesSlide1.xml",
      },
    ])
  )
  files["ppt/slides/_rels/slide2.xml.rels"] = encode(
    rels([
      {
        id: "rId1",
        type: TYPE.slideLayout,
        target: "../slideLayouts/slideLayout1.xml",
      },
    ])
  )
  files["ppt/notesSlides/_rels/notesSlide1.xml.rels"] = encode(
    rels([{ id: "rId1", type: TYPE.slide, target: "../slides/slide1.xml" }])
  )
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = encode(
    rels([
      {
        id: "rId1",
        type: TYPE.slideLayout,
        target: "../slideLayouts/slideLayout1.xml",
      },
    ])
  )
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = encode(
    rels([
      {
        id: "rId1",
        type: TYPE.slideMaster,
        target: "../slideMasters/slideMaster1.xml",
      },
    ])
  )

  files["docProps/core.xml"] = encode(
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:creator>${DECK.author}</dc:creator><cp:lastModifiedBy>${DECK.author}</cp:lastModifiedBy>` +
      `<dc:title>Account review</dc:title></cp:coreProperties>`
  )
  files["docProps/app.xml"] = encode(
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
      `<Application>Microsoft Office PowerPoint</Application><Company>${DECK.client}</Company></Properties>`
  )

  files["_rels/.rels"] = encode(
    rels([
      { id: "rId1", type: TYPE.officeDocument, target: "ppt/presentation.xml" },
      { id: "rId2", type: TYPE.core, target: "docProps/core.xml" },
      { id: "rId3", type: TYPE.app, target: "docProps/app.xml" },
    ])
  )

  const override = (name: string, type: string) =>
    `<Override PartName="/${name}" ContentType="${type}"/>`
  const ML = "application/vnd.openxmlformats-officedocument.presentationml"

  files["[Content_Types].xml"] = encode(
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      override("ppt/presentation.xml", `${ML}.presentation.main+xml`) +
      override("ppt/slides/slide1.xml", `${ML}.slide+xml`) +
      override("ppt/slides/slide2.xml", `${ML}.slide+xml`) +
      override("ppt/notesSlides/notesSlide1.xml", `${ML}.notesSlide+xml`) +
      override("ppt/slideLayouts/slideLayout1.xml", `${ML}.slideLayout+xml`) +
      override("ppt/slideMasters/slideMaster1.xml", `${ML}.slideMaster+xml`) +
      `</Types>`
  )

  return zipSync(files, { level: 6 })
}
