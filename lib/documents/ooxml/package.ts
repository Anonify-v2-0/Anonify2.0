import { unzipSync, zipSync } from "fflate"
import { XMLParser } from "fast-xml-parser"

/**
 * Minimal OOXML container access.
 *
 * DOCX and XLSX are zip archives of XML parts. Reading and writing the parts
 * directly is what lets a redaction remove text from the actual XML — the only
 * place it can hide — while leaving every other part byte-identical, so
 * formatting survives untouched.
 */

export type OoxmlPackage = {
  files: Record<string, Uint8Array>
}

export function openPackage(bytes: Uint8Array): OoxmlPackage {
  return { files: unzipSync(bytes) }
}

export function packPackage(pkg: OoxmlPackage): Uint8Array {
  return zipSync(pkg.files, { level: 6 })
}

export function readPart(pkg: OoxmlPackage, part: string): string | null {
  const bytes = pkg.files[part]
  return bytes ? Buffer.from(bytes).toString("utf8") : null
}

export function writePart(
  pkg: OoxmlPackage,
  part: string,
  xml: string
): void {
  pkg.files[part] = new Uint8Array(Buffer.from(xml, "utf8"))
}

export function listParts(pkg: OoxmlPackage, pattern: RegExp): string[] {
  return Object.keys(pkg.files).filter((name) => pattern.test(name))
}

/**
 * Every part that can carry visible or recoverable document text. Redaction and
 * the security tests both walk these so nothing is inspected in one place and
 * forgotten in the other.
 *
 * Word keeps text in more places than the body — a name in a header is not in
 * `document.xml` at all — and PowerPoint keeps it in more places than the
 * slides: the speaker notes are a separate part, and so is every layout and
 * every master, which is where a template's placeholder text lives.
 */
export const WORD_TEXT_PARTS =
  /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/

export const PPTX_TEXT_PARTS =
  /^ppt\/(slides|notesSlides|slideLayouts|slideMasters|notesMasters|handoutMasters)\/[^/]+\.xml$/

/** Just the slides, in file order; the deck's own order comes from the rels. */
export const PPTX_SLIDE_PARTS = /^ppt\/slides\/slide\d+\.xml$/

export function xmlParser(): XMLParser {
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    trimValues: false,
    parseTagValue: false,
    parseAttributeValue: false,
  })
}

/** Ordered-node shape produced by fast-xml-parser in preserveOrder mode. */
export type XmlNode = Record<string, unknown> & {
  ":@"?: Record<string, string>
}

export function nodeName(node: XmlNode): string {
  return Object.keys(node).find((key) => key !== ":@") ?? ""
}

export function childrenOf(node: XmlNode): XmlNode[] {
  const name = nodeName(node)
  const value = node[name]
  return Array.isArray(value) ? (value as XmlNode[]) : []
}

export function attr(node: XmlNode, name: string): string | undefined {
  return node[":@"]?.[`@_${name}`]
}

/** Depth-first search for the first descendant with the given tag name. */
export function findChild(
  nodes: XmlNode[],
  name: string
): XmlNode | undefined {
  return nodes.find((node) => nodeName(node) === name)
}

export function findChildren(nodes: XmlNode[], name: string): XmlNode[] {
  return nodes.filter((node) => nodeName(node) === name)
}

// --- document properties ----------------------------------------------------

const CORE_PROPERTY_TAGS = [
  "dc:creator",
  "cp:lastModifiedBy",
  "cp:lastPrinted",
  "dc:description",
  "dc:subject",
  "cp:keywords",
  "cp:category",
  "cp:contentStatus",
  "dc:title",
]

const APP_PROPERTY_TAGS = ["Company", "Manager", "Application", "Template"]

/** Empties an element's content while keeping the element and its attributes. */
function blankTags(xml: string, tags: string[]): string {
  let result = xml
  for (const tag of tags) {
    result = result.replace(
      new RegExp(`<${tag}(\\s[^>]*)?>[\\s\\S]*?</${tag}>`, "g"),
      (_match, attributes: string | undefined) =>
        `<${tag}${attributes ?? ""}></${tag}>`
    )
  }
  return result
}

/**
 * Strips authorship and other identifying document properties.
 *
 * `docProps` is the same in every OOXML package, which is the point: a Word
 * document and a deck both carry the author's name in `dc:creator`, and
 * sanitizing one and not the other would be an arbitrary difference nobody
 * would find until it mattered.
 */
export function sanitizeOoxmlMetadata(pkg: OoxmlPackage): void {
  const core = readPart(pkg, "docProps/core.xml")
  if (core) writePart(pkg, "docProps/core.xml", blankTags(core, CORE_PROPERTY_TAGS))

  const app = readPart(pkg, "docProps/app.xml")
  if (app) writePart(pkg, "docProps/app.xml", blankTags(app, APP_PROPERTY_TAGS))

  for (const part of listParts(pkg, /^docProps\/thumbnail\./)) {
    delete pkg.files[part]
  }
}
