/**
 * Text-node surgery on OOXML parts.
 *
 * Redaction edits the XML that actually carries the characters, rather than
 * re-serializing a parsed tree: every byte outside the edited text nodes stays
 * exactly as Word wrote it, so styles, numbering, relationships and section
 * properties survive untouched.
 */

export type TextNode = {
  /** Offset of the node's text content within the XML string. */
  start: number
  end: number
  /** Decoded text content. */
  text: string
  /** Offset of the opening tag, used when attributes must be adjusted. */
  tagStart: number
}

export type ElementRange = {
  start: number
  end: number
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
}

export function decodeXmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    if (entity in ENTITIES) return ENTITIES[entity]
    const numeric = /^&#(x?)([0-9a-fA-F]+);$/.exec(entity)
    if (!numeric) return entity
    const code = parseInt(numeric[2], numeric[1] ? 16 : 10)
    return Number.isFinite(code) ? String.fromCodePoint(code) : entity
  })
}

export function encodeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/** Locates every occurrence of an element, including self-closing forms. */
export function scanElements(xml: string, tag: string): ElementRange[] {
  const ranges: ElementRange[] = []
  const open = new RegExp(`<${tag}(?=[\\s/>])`, "g")

  let match: RegExpExecArray | null
  while ((match = open.exec(xml)) !== null) {
    const tagEnd = xml.indexOf(">", match.index)
    if (tagEnd === -1) break

    if (xml[tagEnd - 1] === "/") {
      ranges.push({ start: match.index, end: tagEnd + 1 })
      open.lastIndex = tagEnd + 1
      continue
    }

    const close = xml.indexOf(`</${tag}>`, tagEnd)
    if (close === -1) break
    const end = close + tag.length + 3
    ranges.push({ start: match.index, end })
    open.lastIndex = end
  }

  return ranges
}

/** Locates the text nodes of a tag (`w:t` in Word, `t` in Excel shared strings). */
export function scanTextNodes(
  xml: string,
  tag: string,
  within?: ElementRange
): TextNode[] {
  const from = within?.start ?? 0
  const to = within?.end ?? xml.length
  const nodes: TextNode[] = []
  const open = new RegExp(`<${tag}(?=[\\s/>])`, "g")
  open.lastIndex = from

  let match: RegExpExecArray | null
  while ((match = open.exec(xml)) !== null && match.index < to) {
    const tagEnd = xml.indexOf(">", match.index)
    if (tagEnd === -1) break

    // A self-closing text node holds nothing to redact.
    if (xml[tagEnd - 1] === "/") {
      open.lastIndex = tagEnd + 1
      continue
    }

    const close = xml.indexOf(`</${tag}>`, tagEnd)
    if (close === -1) break

    nodes.push({
      tagStart: match.index,
      start: tagEnd + 1,
      end: close,
      text: decodeXmlText(xml.slice(tagEnd + 1, close)),
    })
    open.lastIndex = close + tag.length + 3
  }

  return nodes
}

export type TextEdit = {
  node: TextNode
  text: string
}

/**
 * Rewrites text nodes in one pass. Edits are applied back-to-front so earlier
 * offsets stay valid, and `xml:space="preserve"` is added when the replacement
 * has significant whitespace Word would otherwise collapse.
 */
export function applyTextEdits(xml: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((a, b) => b.node.start - a.node.start)
  let result = xml

  for (const edit of ordered) {
    const { node } = edit
    const replacement = encodeXmlText(edit.text)
    result = result.slice(0, node.start) + replacement + result.slice(node.end)

    const needsPreserve =
      /^\s|\s$/.test(edit.text) &&
      !result
        .slice(node.tagStart, node.start)
        .includes('xml:space="preserve"')

    if (needsPreserve) {
      const tagEnd = result.indexOf(">", node.tagStart)
      if (tagEnd !== -1) {
        result =
          result.slice(0, tagEnd) +
          ' xml:space="preserve"' +
          result.slice(tagEnd)
      }
    }
  }

  return result
}

// Cutting and finding character ranges is not an OOXML concern — the CSV
// exporter and the plain-text exporter need exactly the same operations — so
// those live in lib/documents/shared/text.ts and are re-exported here for the
// callers that have always imported them from this module.
export {
  cutRanges,
  findOccurrences,
  mergeRanges,
  type CharRange,
} from "@/lib/documents/shared/text"
