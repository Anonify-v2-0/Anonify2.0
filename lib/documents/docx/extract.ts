import { TextStreamBuilder } from "@/lib/documents/shared/text"
import {
  attr,
  childrenOf,
  findChild,
  nodeName,
  openPackage,
  readPart,
  xmlParser,
  type XmlNode,
} from "@/lib/documents/docx/ooxml"
import type {
  DocxBlock,
  DocxParagraph,
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

function buildParagraph(paragraphNode: XmlNode, counter: Counter): DocxParagraph {
  const index = counter.paragraph()
  const runs: DocxRun[] = []

  collectRuns(paragraphNode).forEach((runNode, runIndex) => {
    const text = textOfRun(runNode)
    if (text.length === 0) return
    runs.push({
      id: `p${index}r${runIndex}`,
      text,
      style: runStyle(runNode),
    })
  })

  return {
    id: `p${index}`,
    type: "paragraph",
    runs,
    ...paragraphProps(paragraphNode),
  }
}

function buildTable(tableNode: XmlNode, counter: Counter): DocxTable {
  const id = `tbl${counter.table()}`
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
          paragraphs.push(buildParagraph(child, counter))
        } else if (name === "w:tbl") {
          // A nested table still contributes its paragraphs in document order.
          for (const nested of buildTable(child, counter).rows.flat(2)) {
            paragraphs.push(nested)
          }
        }
      }
      cells.push(paragraphs)
    }

    rows.push(cells)
  }

  return { id, type: "table", rows }
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

export function extractDocx(
  documentId: string,
  bytes: Uint8Array
): DocxExtraction {
  const pkg = openPackage(bytes)
  const xml = readPart(pkg, "word/document.xml")
  if (!xml) {
    throw new Error("word/document.xml is missing; the file is not a DOCX")
  }

  const parsed = xmlParser().parse(xml) as XmlNode[]
  const documentNode = parsed.find((node) => nodeName(node) === "w:document")
  const body = documentNode
    ? findChild(childrenOf(documentNode), "w:body")
    : undefined

  const counter = new Counter()
  const pages: NormalizedPage[] = []
  let blocks: DocxBlock[] = []

  for (const node of body ? childrenOf(body) : []) {
    const name = nodeName(node)
    if (name === "w:p") {
      const breaks = hasPageBreak(node)
      blocks.push(buildParagraph(node, counter))
      if (breaks) {
        pages.push(pageFrom(pages.length + 1, blocks))
        blocks = []
      }
    } else if (name === "w:tbl") {
      blocks.push(buildTable(node, counter))
    }
  }

  // A document with no explicit breaks is a single continuous page.
  if (blocks.length > 0 || pages.length === 0) {
    pages.push(pageFrom(pages.length + 1, blocks))
  }

  return {
    document: {
      documentId,
      kind: "docx",
      pages,
      metadata: { pageCount: pages.length },
    },
  }
}
