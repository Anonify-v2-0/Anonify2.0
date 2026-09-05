import {
  emlLimits,
  EmlLimitError,
  type EmlLimits,
} from "@/lib/documents/eml/limits"

/**
 * RFC 822 / MIME, parsed into a tree that still knows where it came from.
 *
 * An email is not a text file with a header on it. It is a tree: a message
 * holds parts, a part can be another message, and the same person's name can
 * appear in a header, in the plain-text body, in the HTML alternative of that
 * body, inside a quoted reply, and in an attachment's filename. Flattening
 * that into "the body text" — which is what most extraction does — loses four
 * of those five places, and a redaction tool that misses four out of five is
 * worse than none, because it is trusted.
 *
 * So the tree is preserved, every node knows its byte range in the original
 * message, and every text-bearing thing gets a stable address. The exporter
 * then works in byte ranges: parts nobody edited come out identical to the
 * byte, including nested messages and the boundaries between them.
 *
 * Bytes are read as Latin-1 so that one character is one byte and an offset is
 * an offset. Transfer decoding and charset decoding happen per part, on the
 * bytes that part actually spans.
 */

export type MimeHeader = {
  /** Lowercased, for lookup. */
  name: string
  /** As written, for rewriting the line without changing its case. */
  rawName: string
  /** Decoded value: unfolded, with RFC 2047 encoded words resolved. */
  value: string
  /** Byte range of the whole header line, folded continuations included. */
  start: number
  end: number
  /** Byte range of the value alone, after the colon and its space. */
  valueStart: number
  valueEnd: number
  /** Which occurrence of this header name this is, from zero. */
  index: number
}

export type MimeNode = {
  /** Dotted path from the root: "0", "0.1", "0.2.msg", … */
  path: string
  /** Multipart nesting depth, counted from zero at the root. */
  depth: number
  /** Byte range of the whole node, headers included. */
  start: number
  end: number
  headers: MimeHeader[]
  bodyStart: number
  bodyEnd: number
  /** Lowercased `type/subtype`; defaults to text/plain per RFC 2045. */
  contentType: string
  parameters: Record<string, string>
  charset: string
  /** Lowercased Content-Transfer-Encoding. */
  encoding: string
  disposition: string | null
  /** From Content-Disposition's `filename` or Content-Type's `name`. */
  filename: string | null
  boundary: string | null
  children: MimeNode[]
  /** The message inside a `message/rfc822` part. */
  nested: MimeNode | null
  /** Decoded content, for text parts only. */
  text: string | null
  /** True for a part whose bytes we will not rewrite. */
  attachment: boolean
}

export type ParsedMessage = {
  root: MimeNode
  /** Every node in document order, the root first. */
  nodes: MimeNode[]
  limits: EmlLimits
}

export class EmlParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EmlParseError"
  }
}

export function decodeEml(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1")
}

export function encodeEml(source: string): Uint8Array {
  return new Uint8Array(Buffer.from(source, "latin1"))
}

/**
 * Whether these bytes are plausibly a message.
 *
 * Not "does it contain an @" — a CSV contains an @. A message begins with
 * header lines, and at least one of them has to be a header a message actually
 * has. This is the check that stops a text file with a colon in it being
 * offered to the MIME parser.
 */
export function looksLikeEml(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 8192)).toString("latin1")
  const blank = head.search(/\r?\n\r?\n/)
  const block = blank === -1 ? head : head.slice(0, blank)

  const lines = block.split(/\r?\n/).filter((line) => line.length > 0)
  if (lines.length === 0) return false

  // Every line in the block must be a header or a folded continuation of one.
  const wellFormed = lines.every(
    (line) => /^[ \t]/.test(line) || /^[!-9;-~]+:/.test(line)
  )
  if (!wellFormed) return false

  const names = new Set(
    lines
      .filter((line) => !/^[ \t]/.test(line))
      .map((line) => line.slice(0, line.indexOf(":")).toLowerCase())
  )

  // One of the headers every real message carries. A file of arbitrary
  // `key: value` lines is a configuration file, not an email.
  return [
    "from",
    "to",
    "subject",
    "date",
    "message-id",
    "received",
    "mime-version",
    "return-path",
  ].some((required) => names.has(required))
}

// --- header parsing ---------------------------------------------------------

const BASE64_ALPHABET = /^[A-Za-z0-9+/=\s]*$/

/** RFC 2047: `=?utf-8?B?SGVsbG8=?=` and its quoted-printable sibling. */
export function decodeEncodedWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (match, charset: string, encoding: string, payload: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === "b"
            ? Buffer.from(payload, "base64")
            : Buffer.from(
                payload
                  .replace(/_/g, " ")
                  .replace(/=([0-9A-Fa-f]{2})/g, (_all, hex: string) =>
                    String.fromCharCode(parseInt(hex, 16))
                  ),
                "latin1"
              )
        return decodeCharset(bytes, charset)
      } catch {
        // An encoded word we cannot read is left as written rather than
        // dropped: it is still content, and a reviewer can see it.
        return match
      }
    }
  )
}

/**
 * Decodes bytes in a named charset.
 *
 * Unknown or unsupported labels fall back to Latin-1, which cannot throw and
 * cannot lose a byte — every byte maps to a character, so nothing disappears
 * from what the detectors get to read.
 */
export function decodeCharset(bytes: Buffer, charset: string): string {
  const label = charset.trim().toLowerCase().replace(/^["']|["']$/g, "")
  try {
    return new TextDecoder(label || "utf-8").decode(bytes)
  } catch {
    return bytes.toString("latin1")
  }
}

/** Splits `value; name=x; other="y"` into its value and its parameters. */
export function parseParameters(raw: string): {
  value: string
  parameters: Record<string, string>
} {
  const parameters: Record<string, string> = {}
  const pieces = splitOutsideQuotes(raw, ";")
  const value = (pieces.shift() ?? "").trim()

  for (const piece of pieces) {
    const equals = piece.indexOf("=")
    if (equals === -1) continue
    const name = piece.slice(0, equals).trim().toLowerCase()
    let parameterValue = piece.slice(equals + 1).trim()
    if (parameterValue.startsWith('"') && parameterValue.endsWith('"')) {
      parameterValue = parameterValue.slice(1, -1).replace(/\\(.)/g, "$1")
    }
    if (name) parameters[name] = parameterValue
  }

  // RFC 2231 splits a long parameter across `name*0`, `name*1`, … and can
  // charset-tag it. A filename carrying someone's name arrives this way often
  // enough that ignoring it would mean not offering it for review.
  const continued = new Map<string, string[]>()
  for (const [name, parameterValue] of Object.entries(parameters)) {
    const match = /^([^*]+)\*(\d+)\*?$/.exec(name)
    if (!match) continue
    const parts = continued.get(match[1]) ?? []
    parts[Number(match[2])] = parameterValue
    continued.set(match[1], parts)
    delete parameters[name]
  }
  for (const [name, parts] of continued) {
    parameters[name] = decodeExtendedParameter(parts.join(""))
  }
  for (const [name, parameterValue] of Object.entries(parameters)) {
    if (name.endsWith("*")) {
      parameters[name.slice(0, -1)] = decodeExtendedParameter(parameterValue)
      delete parameters[name]
    }
  }

  return { value, parameters }
}

/** `utf-8''caf%C3%A9.pdf` — RFC 2231's charset-tagged form. */
function decodeExtendedParameter(value: string): string {
  const match = /^([^']*)'([^']*)'(.*)$/.exec(value)
  const charset = match ? match[1] : "utf-8"
  const encoded = match ? match[3] : value

  const bytes = Buffer.from(
    encoded.replace(/%([0-9A-Fa-f]{2})/g, (_all, hex: string) =>
      String.fromCharCode(parseInt(hex, 16))
    ),
    "latin1"
  )
  return decodeCharset(bytes, charset)
}

function splitOutsideQuotes(value: string, separator: string): string[] {
  const pieces: string[] = []
  let current = ""
  let quoted = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (character === '"' && value[index - 1] !== "\\") quoted = !quoted
    if (character === separator && !quoted) {
      pieces.push(current)
      current = ""
      continue
    }
    current += character
  }
  pieces.push(current)
  return pieces
}

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

export function parseHeaders(
  source: string,
  start: number,
  end: number
): MimeHeader[] {
  const headers: MimeHeader[] = []
  const counts = new Map<string, number>()

  let index = start
  while (index < end) {
    let lineEnd = source.indexOf("\n", index)
    if (lineEnd === -1 || lineEnd >= end) lineEnd = end
    else lineEnd += 1

    const line = source.slice(index, lineEnd)
    if (/^\r?\n$/.test(line)) break

    const colon = line.indexOf(":")
    if (colon === -1 || /^[ \t]/.test(line)) {
      // A continuation with nothing to continue, or a line that is not a
      // header at all. Skipped rather than thrown on: real mail has both.
      index = lineEnd
      continue
    }

    // Take the folded continuations with it.
    let valueEnd = lineEnd
    while (valueEnd < end && /^[ \t]/.test(source[valueEnd] ?? "")) {
      let next = source.indexOf("\n", valueEnd)
      if (next === -1 || next >= end) next = end
      else next += 1
      valueEnd = next
    }

    const rawName = line.slice(0, colon)
    const name = rawName.trim().toLowerCase()
    const valueStart = index + colon + 1
    const raw = source.slice(valueStart, valueEnd)

    const occurrence = counts.get(name) ?? 0
    counts.set(name, occurrence + 1)

    headers.push({
      name,
      rawName: rawName.trim(),
      value: decodeEncodedWords(unfold(raw)).trim(),
      start: index,
      end: valueEnd,
      valueStart,
      valueEnd,
      index: occurrence,
    })

    index = valueEnd
  }

  return headers
}

/** Joins a folded header value into one line, as a reader sees it. */
export function unfold(value: string): string {
  return value.replace(/\r?\n[ \t]+/g, " ").replace(/\r?\n/g, "")
}

export function headerValue(node: MimeNode, name: string): string | null {
  const header = node.headers.find((candidate) => candidate.name === name)
  return header ? header.value : null
}

// --- body decoding ----------------------------------------------------------

export function decodeQuotedPrintable(value: string): Buffer {
  const withoutSoftBreaks = value.replace(/=\r?\n/g, "")
  const bytes: number[] = []

  for (let index = 0; index < withoutSoftBreaks.length; index++) {
    const character = withoutSoftBreaks[index]
    if (character === "=") {
      const hex = withoutSoftBreaks.slice(index + 1, index + 3)
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(parseInt(hex, 16))
        index += 2
        continue
      }
    }
    bytes.push(character.charCodeAt(0) & 0xff)
  }

  return Buffer.from(bytes)
}

/** Undoes the transfer encoding, giving the part's actual bytes. */
export function decodeTransfer(raw: string, encoding: string): Buffer {
  switch (encoding) {
    case "base64":
      // A body that is not base64 at all decodes to noise; treating it as
      // Latin-1 keeps whatever text is really there readable.
      if (!BASE64_ALPHABET.test(raw)) return Buffer.from(raw, "latin1")
      return Buffer.from(raw.replace(/\s+/g, ""), "base64")
    case "quoted-printable":
      return decodeQuotedPrintable(raw)
    default:
      return Buffer.from(raw, "latin1")
  }
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

export function parseEml(
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
