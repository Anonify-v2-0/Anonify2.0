import { TextStreamBuilder } from "@/lib/documents/shared/text"
import {
  attr,
  childrenOf,
  findChild,
  listParts,
  nodeName,
  openPackage,
  readPart,
  WORD_TEXT_PARTS,
  xmlParser,
  type XmlNode,
} from "@/lib/documents/docx/ooxml"
import type {
  DocxBlock,
  DocxParagraph,
  DocxRegion,
  DocxRun,
  DocxTable,
  NormalizedDocument,
  NormalizedPage,
  TextStyle,
} from "@/types/document"

/**
 * DOCX extraction.
 *
 * Walks word/document.xml in document order and gives every paragraph and run a
 * positional address (p3r1). Export re-walks the identical order, so an address
 * captured here still points at the same run later — no markers are injected
 * into the user's file to make that work.
 */

const HALF_POINTS_PER_POINT = 2
const TWIPS_PER_POINT = 20

function textOfRun(runNode: XmlNode): string {
  let text = ""
  for (const child of childrenOf(runNode)) {
    const name = nodeName(child)
    if (name === "w:t") {
      const parts = childrenOf(child)
      for (const part of parts) {
        if ("#text" in part) text += String(part["#text"])
      }
    } else if (name === "w:tab") {
      text += "\t"
    } else if (name === "w:br") {
      text += "\n"
    } else if (name === "w:noBreakHyphen") {
      text += "-"
    }
  }
  return text
}

function runStyle(runNode: XmlNode): TextStyle | undefined {
  const properties = findChild(childrenOf(runNode), "w:rPr")
  if (!properties) return undefined

  const style: TextStyle = {}
  for (const child of childrenOf(properties)) {
    switch (nodeName(child)) {
      case "w:b":
        style.bold = attr(child, "w:val") !== "0"
        break
      case "w:i":
        style.italic = attr(child, "w:val") !== "0"
        break
      case "w:u":
        style.underline = attr(child, "w:val") !== "none"
        break
      case "w:sz": {
        const halfPoints = Number(attr(child, "w:val"))
        if (Number.isFinite(halfPoints)) {
          style.fontSize = halfPoints / HALF_POINTS_PER_POINT
        }
        break
      }
      case "w:color": {
        const value = attr(child, "w:val")
        if (value && value !== "auto") style.color = `#${value}`
        break
      }
      case "w:rFonts":
        style.fontFamily = attr(child, "w:ascii") ?? attr(child, "w:hAnsi")
        break
    }
  }

  return Object.keys(style).length > 0 ? style : undefined
}

type ParagraphProps = Pick<
  DocxParagraph,
  "headingLevel" | "listLevel" | "alignment" | "indent" | "spacingBefore" | "spacingAfter"
>

function paragraphProps(paragraphNode: XmlNode): ParagraphProps {
  const properties = findChild(childrenOf(paragraphNode), "w:pPr")
  const props: ParagraphProps = {}
  if (!properties) return props

  for (const child of childrenOf(properties)) {
    switch (nodeName(child)) {
      case "w:pStyle": {
        const value = attr(child, "w:val") ?? ""
        const heading = /^Heading(\d)$/i.exec(value)
        if (heading) props.headingLevel = Number(heading[1])
        break
      }
      case "w:jc": {
        const value = attr(child, "w:val")
        if (value === "center" || value === "right" || value === "justify") {
          props.alignment = value
        } else if (value === "left" || value === "start") {
          props.alignment = "left"
        }
        break
      }
      case "w:numPr": {
        const level = findChild(childrenOf(child), "w:ilvl")
        props.listLevel = level ? Number(attr(level, "w:val") ?? 0) : 0
        break
      }
      case "w:ind": {
        const left = Number(attr(child, "w:left") ?? attr(child, "w:start"))
        if (Number.isFinite(left)) props.indent = left / TWIPS_PER_POINT
        break
      }
      case "w:spacing": {
        const before = Number(attr(child, "w:before"))
        const after = Number(attr(child, "w:after"))
        if (Number.isFinite(before)) props.spacingBefore = before / TWIPS_PER_POINT
        if (Number.isFinite(after)) props.spacingAfter = after / TWIPS_PER_POINT
        break
      }
    }
  }

  return props
}

/** True when the paragraph contains an explicit page break. */
function hasPageBreak(paragraphNode: XmlNode): boolean {
  for (const run of childrenOf(paragraphNode)) {
    if (nodeName(run) !== "w:r") continue
    for (const child of childrenOf(run)) {
      if (nodeName(child) === "w:br" && attr(child, "w:type") === "page") {
        return true
      }
    }
  }
  return false
}

/**
 * Paragraphs and runs are addressed by their position in document order, which
 * is exactly the order the exporter re-discovers them in. Both walks must agree
 * or an accepted redaction would land on the wrong run, so both count every
 * paragraph and every run, wherever they are nested.
 */
class Counter {
  private nextParagraph = 0
  private nextTable = 0

  paragraph(): number {
    return this.nextParagraph++
  }

  table(): number {
    return this.nextTable++
  }
}

/** Collects `w:r` descendants in document order (runs nest inside hyperlinks). */
function collectRuns(node: XmlNode, into: XmlNode[] = []): XmlNode[] {
  for (const child of childrenOf(node)) {
    const name = nodeName(child)
    if (name === "w:r") {
      into.push(child)
    } else if (name !== "w:pPr" && name !== "w:rPr") {
      collectRuns(child, into)
    }
  }
  return into
}

/**
 * Addresses are qualified by the part they live in, because each part is walked
 * — and later re-walked by the exporter — independently. `word/header1.xml#p0r1`
 * is the second run of the first paragraph of that header.
 */
export const PART_SEPARATOR = "#"

export function spanAddress(part: string, paragraph: number, run: number): string {
  return `${part}${PART_SEPARATOR}p${paragraph}r${run}`
}

/** Splits an address back into the part and the local `p{n}r{m}` key. */
export function parseSpanAddress(
  address: string
): { part: string; local: string } | null {
  const index = address.indexOf(PART_SEPARATOR)
  if (index === -1) return null
  return {
    part: address.slice(0, index),
    local: address.slice(index + 1),
  }
}

type PartContext = { part: string; region: DocxRegion; counter: Counter }

function buildParagraph(
  paragraphNode: XmlNode,
  context: PartContext
): DocxParagraph {
  const index = context.counter.paragraph()
  const runs: DocxRun[] = []

  collectRuns(paragraphNode).forEach((runNode, runIndex) => {
    const text = textOfRun(runNode)
    if (text.length === 0) return
    runs.push({
      id: spanAddress(context.part, index, runIndex),
      text,
      style: runStyle(runNode),
    })
  })

  return {
    id: `${context.part}${PART_SEPARATOR}p${index}`,
    type: "paragraph",
    region: context.region,
    part: context.part,
    runs,
    ...paragraphProps(paragraphNode),
  }
}

function buildTable(tableNode: XmlNode, context: PartContext): DocxTable {
  const id = `${context.part}${PART_SEPARATOR}tbl${context.counter.table()}`
  const rows: DocxParagraph[][][] = []

  for (const rowNode of childrenOf(tableNode)) {
    if (nodeName(rowNode) !== "w:tr") continue
    const cells: DocxParagraph[][] = []

    for (const cellNode of childrenOf(rowNode)) {
      if (nodeName(cellNode) !== "w:tc") continue
      const paragraphs: DocxParagraph[] = []
      for (const child of childrenOf(cellNode)) {
        const name = nodeName(child)
        if (name === "w:p") {
          paragraphs.push(buildParagraph(child, context))
        } else if (name === "w:tbl") {
          // A nested table still contributes its paragraphs in document order.
          for (const nested of buildTable(child, context).rows.flat(2)) {
            paragraphs.push(nested)
          }
        }
      }
      cells.push(paragraphs)
    }

    rows.push(cells)
  }

  return { id, type: "table", region: context.region, part: context.part, rows }
}

/**
 * Collects paragraphs and tables from anywhere in a part, in document order.
 *
 * Each part wraps its content differently — `w:body`, `w:hdr`, `w:ftr`,
 * `w:footnote`, `w:comment` — so rather than encode every wrapper this walks
 * through anything that is not itself a block. Tables are not descended into
 * here; `buildTable` handles their paragraphs so they are counted exactly once.
 */
function collectBlocks(
  node: XmlNode,
  context: PartContext,
  into: DocxBlock[] = [],
  onPageBreak?: (blockCount: number) => void
): DocxBlock[] {
  for (const child of childrenOf(node)) {
    const name = nodeName(child)
    if (name === "w:p") {
      const breaks = hasPageBreak(child)
      into.push(buildParagraph(child, context))
      // Reported as a position rather than by handing the caller a new array:
      // the walker keeps pushing into `into`, so swapping it out here would
      // silently send the rest of the document to the previous page.
      if (breaks) onPageBreak?.(into.length)
    } else if (name === "w:tbl") {
      into.push(buildTable(child, context))
    } else if (name !== "w:sectPr" && name !== "w:pPr") {
      collectBlocks(child, context, into, onPageBreak)
    }
  }
  return into
}

/** Maps a part path onto the region it represents. */
export function regionOfPart(part: string): DocxRegion {
  if (/^word\/header\d*\.xml$/.test(part)) return "header"
  if (/^word\/footer\d*\.xml$/.test(part)) return "footer"
  if (part === "word/footnotes.xml") return "footnote"
  if (part === "word/endnotes.xml") return "endnote"
  if (part === "word/comments.xml") return "comment"
  return "body"
}

/** Default Word page geometry (US Letter at 72dpi), used by the renderer. */
const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792

function pageFrom(number: number, blocks: DocxBlock[]): NormalizedPage {
  const builder = new TextStreamBuilder()

  const emitParagraph = (paragraph: DocxParagraph) => {
    for (const run of paragraph.runs) {
      builder.append(run.id, run.text, { blockId: paragraph.id, style: run.style })
    }
    builder.pad("\n")
  }

  for (const block of blocks) {
    if (block.type === "paragraph") {
      emitParagraph(block)
      continue
    }
    for (const row of block.rows) {
      for (const cell of row) {
        for (const paragraph of cell) emitParagraph(paragraph)
      }
    }
  }

  return {
    number,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    text: builder.text,
    spans: builder.spans,
    blocks,
  }
}

export type DocxExtraction = {
  document: NormalizedDocument
}

/**
 * Order the regions appear in on page one. Headers and footers apply to the
 * whole document, so they are attached to the first page rather than repeated
 * on every one — repeating them would produce a duplicate suggestion per page
 * for the same underlying run.
 */
const REGION_ORDER: DocxRegion[] = [
  "header",
  "body",
  "footnote",
  "endnote",
  "comment",
  "footer",
]

export function extractDocx(
  documentId: string,
  bytes: Uint8Array
): DocxExtraction {
  const pkg = openPackage(bytes)
  const bodyXml = readPart(pkg, "word/document.xml")
  if (!bodyXml) {
    throw new Error("word/document.xml is missing; the file is not a DOCX")
  }

  const parser = xmlParser()

  const blocksOfPart = (
    part: string,
    onPageBreak?: (blockCount: number) => void
  ): DocxBlock[] => {
    const xml = readPart(pkg, part)
    if (!xml) return []

    const context: PartContext = {
      part,
      region: regionOfPart(part),
      counter: new Counter(),
    }

    const blocks: DocxBlock[] = []
    for (const node of parser.parse(xml) as XmlNode[]) {
      collectBlocks(node, context, blocks, onPageBreak)
    }
    return blocks
  }

  // The body is the only part that paginates.
  const boundaries: number[] = []
  const bodyBlocks = blocksOfPart("word/document.xml", (count) =>
    boundaries.push(count)
  )

  const bodyPages: DocxBlock[][] = []
  let cursor = 0
  for (const boundary of boundaries) {
    bodyPages.push(bodyBlocks.slice(cursor, boundary))
    cursor = boundary
  }
  if (cursor < bodyBlocks.length || bodyPages.length === 0) {
    bodyPages.push(bodyBlocks.slice(cursor))
  }

  // Headers, footers, footnotes and comments carry text the exporter already
  // sweeps. Extracting them is what makes that text reviewable, so what the
  // user sees matches what the export touches.
  const surrounding = listParts(pkg, WORD_TEXT_PARTS)
    .filter((part) => part !== "word/document.xml")
    .sort()
    .flatMap((part) => blocksOfPart(part))

  const pages = bodyPages.map((blocks, index) => {
    const combined =
      index === 0 ? orderRegions([...surrounding, ...blocks]) : blocks
    return pageFrom(index + 1, combined)
  })

  return {
    document: {
      documentId,
      kind: "docx",
      pages,
      metadata: {
        pageCount: pages.length,
        parts: listParts(pkg, WORD_TEXT_PARTS).sort(),
      },
    },
  }
}

function orderRegions(blocks: DocxBlock[]): DocxBlock[] {
  return [...blocks].sort(
    (a, b) =>
      REGION_ORDER.indexOf(a.region ?? "body") -
      REGION_ORDER.indexOf(b.region ?? "body")
  )
}
