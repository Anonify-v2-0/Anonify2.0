/**
 * The recursive MIME parser as it stood before lib/documents/eml/scan.ts
 * replaced it, kept verbatim as the oracle the scanner is held to. Not used
 * outside the tests.
 */
import {
  emlLimits,
  EmlLimitError,
  type EmlLimits,
} from "@/lib/documents/eml/limits"
import {
  decodeCharset,
  decodeTransfer,
  EmlParseError,
  parseHeaders,
  parseParameters,
  type MimeNode,
  type ParsedMessage,
} from "@/lib/documents/eml/parse"

/** Where a node's headers end and its body begins. */
function headerBlockEnd(source: string, start: number, end: number): number {
  for (let index = start; index < end; index++) {
    if (source[index] !== "\n") continue
    // \n\n or \n\r\n
    if (source[index + 1] === "\n") return index + 2
    if (source[index + 1] === "\r" && source[index + 2] === "\n") return index + 3
  }
  return end
}

// --- the tree ---------------------------------------------------------------

type Budget = {
  parts: number
  textBytes: number
  attachments: number
}

function isTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "message/delivery-status" ||
    contentType === "message/disposition-notification"
  )
}

/** Finds the ranges between a multipart's boundary delimiters. */
function splitOnBoundary(
  source: string,
  bodyStart: number,
  bodyEnd: number,
  boundary: string
): { start: number; end: number }[] {
  const delimiter = `--${boundary}`
  const ranges: { start: number; end: number }[] = []

  let cursor = bodyStart
  let partStart: number | null = null

  while (cursor < bodyEnd) {
    let lineEnd = source.indexOf("\n", cursor)
    if (lineEnd === -1 || lineEnd > bodyEnd) lineEnd = bodyEnd
    else lineEnd += 1

    const line = source.slice(cursor, lineEnd).replace(/\r?\n$/, "")

    if (line === delimiter || line === `${delimiter}--`) {
      if (partStart !== null) {
        // The CRLF before a delimiter belongs to the delimiter, not the part.
        let end = cursor
        if (source[end - 1] === "\n") end -= 1
        if (source[end - 1] === "\r") end -= 1
        ranges.push({ start: partStart, end })
      }
      partStart = line.endsWith("--") ? null : lineEnd
      if (line.endsWith("--")) break
    }

    cursor = lineEnd
  }

  // A multipart whose closing delimiter is missing still has a last part, and
  // discarding it would hide content rather than report a problem.
  if (partStart !== null && partStart < bodyEnd) {
    ranges.push({ start: partStart, end: bodyEnd })
  }

  return ranges
}

function parseNode(
  source: string,
  start: number,
  end: number,
  path: string,
  depth: number,
  nestedDepth: number,
  limits: EmlLimits,
  budget: Budget,
  nodes: MimeNode[]
): MimeNode {
  if (depth > limits.maxDepth) {
    throw new EmlLimitError("maxDepth", limits.maxDepth)
  }
  budget.parts += 1
  if (budget.parts > limits.maxParts) {
    throw new EmlLimitError("maxParts", limits.maxParts)
  }

  const bodyStart = headerBlockEnd(source, start, end)
  if (bodyStart - start > limits.maxHeaderBytes) {
    throw new EmlLimitError("maxHeaderBytes", limits.maxHeaderBytes)
  }

  const headers = parseHeaders(source, start, bodyStart)

  const typeHeader = headers.find((header) => header.name === "content-type")
  const parsedType = parseParameters(typeHeader?.value ?? "text/plain")
  const contentType = (parsedType.value || "text/plain").toLowerCase()

  const dispositionHeader = headers.find(
    (header) => header.name === "content-disposition"
  )
  const parsedDisposition = parseParameters(dispositionHeader?.value ?? "")

  const encoding = (
    headers.find((header) => header.name === "content-transfer-encoding")
      ?.value ?? "7bit"
  )
    .trim()
    .toLowerCase()

  const filename =
    parsedDisposition.parameters.filename ?? parsedType.parameters.name ?? null

  const node: MimeNode = {
    path,
    depth,
    start,
    end,
    headers,
    bodyStart,
    bodyEnd: end,
    contentType,
    parameters: parsedType.parameters,
    charset: parsedType.parameters.charset ?? "utf-8",
    encoding,
    disposition: parsedDisposition.value
      ? parsedDisposition.value.toLowerCase()
      : null,
    filename,
    boundary: parsedType.parameters.boundary ?? null,
    children: [],
    nested: null,
    text: null,
    attachment: false,
  }

  nodes.push(node)

  if (contentType.startsWith("multipart/") && node.boundary) {
    for (const [index, range] of splitOnBoundary(
      source,
      bodyStart,
      end,
      node.boundary
    ).entries()) {
      node.children.push(
        parseNode(
          source,
          range.start,
          range.end,
          `${path}.${index + 1}`,
          depth + 1,
          nestedDepth,
          limits,
          budget,
          nodes
        )
      )
    }
    return node
  }

  if (contentType === "message/rfc822") {
    if (nestedDepth + 1 > limits.maxNestedMessages) {
      throw new EmlLimitError("maxNestedMessages", limits.maxNestedMessages)
    }
    node.nested = parseNode(
      source,
      bodyStart,
      end,
      `${path}.msg`,
      depth + 1,
      nestedDepth + 1,
      limits,
      budget,
      nodes
    )
    return node
  }

  const raw = source.slice(bodyStart, end)

  if (isTextual(contentType) && node.disposition !== "attachment") {
    const decoded = decodeTransfer(raw, encoding)
    budget.textBytes += decoded.byteLength
    if (budget.textBytes > limits.maxTextBytes) {
      throw new EmlLimitError("maxTextBytes", limits.maxTextBytes)
    }
    node.text = decodeCharset(decoded, node.charset)
    return node
  }

  // Anything else is carried through untouched. Its filename is still
  // reviewable, because a filename is where a surprising amount of personal
  // data lives — `2024-tax-return-john-smith.pdf` says everything.
  node.attachment = true
  budget.attachments += 1
  if (budget.attachments > limits.maxAttachments) {
    throw new EmlLimitError("maxAttachments", limits.maxAttachments)
  }

  return node
}

export function recursiveParseEml(
  source: string,
  limits: EmlLimits = emlLimits()
): ParsedMessage {
  if (source.trim().length === 0) {
    throw new EmlParseError("Message is empty")
  }

  const nodes: MimeNode[] = []
  const root = parseNode(
    source,
    0,
    source.length,
    "0",
    0,
    0,
    limits,
    { parts: 0, textBytes: 0, attachments: 0 },
    nodes
  )

  if (root.headers.length === 0) {
    throw new EmlParseError("Message has no headers")
  }

  return { root, nodes, limits }
}
