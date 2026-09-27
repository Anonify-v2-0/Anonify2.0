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
  type MimeHeader,
  type MimeNode,
  type ParsedMessage,
} from "@/lib/documents/eml/parse"

/**
 * The MIME tree, found in one forward pass.
 *
 * `parseEml` used to split a message recursively: find a multipart's
 * delimiters across its whole body, then parse each part the same way. That
 * needs the whole message as one string, attachments included — and the
 * attachments are nearly always most of it. This reads the message once,
 * front to back, a line at a time, keeping the delimiters of every open
 * multipart on a stack, and holds only what the tree is made of: header
 * blocks and the text parts. An attachment's body goes past without being
 * kept; its node records where it was, and anything that needs it reads that
 * range back from storage.
 *
 * Every byte offset has to be exactly what the recursive parser produced,
 * because the exporter edits the original message by them and the address
 * map resolves reviewed spans through them. So this is not a new reading of
 * RFC 2046. It reproduces the recursive parser, quirks included, and each
 * quirk is written down where it is handled:
 *
 *   - An enclosing multipart's delimiter always wins: the recursive parser
 *     split the outer body first, so an inner part never saw an outer
 *     delimiter line. Delimiters are checked outermost first.
 *   - A part ends before the CRLF (or LF) that precedes the delimiter.
 *   - Headers end at the first `\n` at or after the part's start that is
 *     followed by an empty line — so a blank first line does not end them,
 *     and a header block that runs into the delimiter's CRLF ends one or two
 *     bytes past the part's end.
 *   - A part closed by its multipart's delimiter exists however short it is;
 *     the last part of a multipart with no closing delimiter exists only if
 *     it holds at least one byte. A part that has just begun is therefore
 *     tentative until it is known to be one of those.
 *   - Nothing is refused before "Message is empty": a message of whitespace
 *     is reported as empty whatever limit its whitespace would have broken.
 *
 * tests/eml-scan.test.ts holds this to the recursive parser, which it keeps
 * as an oracle, across generated and mutated messages cut into pieces at
 * every size.
 */

type Budget = { parts: number; textBytes: number; attachments: number }

type Phase =
  /** Begun, not yet known to exist. */
  | "tentative"
  /** Exists; its header block has not ended. */
  | "headers"
  | "multipart"
  | "message"
  | "text"
  | "attachment"

type Open = {
  phase: Phase
  path: string
  depth: number
  nestedDepth: number
  start: number
  node: MimeNode | null
  bodyStart: number
  // multipart
  delimiter: string
  closed: boolean
  partStart: number | null
  children: number
}

function isTextual(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType === "message/delivery-status" ||
    contentType === "message/disposition-notification"
  )
}

/** Retained text, addressed by offsets into the whole message. */
class Window {
  private text = ""
  private base = 0

  get end(): number {
    return this.base + this.text.length
  }

  append(piece: string): void {
    this.text += piece
  }

  charAt(index: number): string | undefined {
    if (index < this.base || index >= this.end) return undefined
    return this.text[index - this.base]
  }

  slice(start: number, end: number): string {
    if (start < this.base) {
      throw new Error("MIME scanner read text it had already let go")
    }
    return this.text.slice(start - this.base, Math.max(start, end) - this.base)
  }

  indexOf(search: string, from: number): number {
    const found = this.text.indexOf(search, Math.max(0, from - this.base))
    return found === -1 ? -1 : found + this.base
  }

  /** Lets go of everything before `offset`. */
  release(offset: number): void {
    if (offset <= this.base) return
    const cut = Math.min(offset, this.end) - this.base
    this.text = this.text.slice(cut)
    this.base += cut
  }
}

export class MimeScanner {
  private readonly window = new Window()
  private readonly stack: Open[] = []
  private readonly nodes: MimeNode[] = []
  private readonly budget: Budget = { parts: 0, textBytes: 0, attachments: 0 }
  private root: MimeNode | null = null
  /** Start of the line not yet complete. */
  private lineStart = 0
  /** Whether the incomplete line has grown past any delimiter's length. */
  private lineTooLong = false
  private sawContent = false
  /** A limit broken before anything but whitespace was seen; see `end`. */
  private deferred: unknown = null
  private finished = false

  constructor(private readonly limits: EmlLimits = emlLimits()) {
    // The root always exists; the recursive parser began by parsing it.
    const root = this.open("tentative", "0", 0, 0, 0)
    this.stack.push(root)
    this.guard(() => this.create(root))
  }

  /** The next piece of the message, decoded as Latin-1. */
  write(text: string): void {
    if (this.finished) throw new Error("MIME scanner has already finished")
    if (text.length === 0) return
    if (!this.sawContent && /\S/.test(text)) this.sawContent = true
    if (this.deferred) return

    this.window.append(text)
    this.guard(() => {
      for (;;) {
        const newline = this.window.indexOf("\n", this.lineStart)
        if (newline === -1) break
        this.line(this.lineStart, newline + 1, this.lineTooLong)
        this.lineStart = newline + 1
        this.lineTooLong = false
      }
      this.refuseEndlessHeaders(this.window.end - 2)
      this.trimLongLine()
      this.release()
    })
  }

  end(): ParsedMessage {
    if (this.finished) throw new Error("MIME scanner has already finished")
    this.finished = true

    if (!this.sawContent) throw new EmlParseError("Message is empty")
    if (this.deferred) throw this.deferred

    const eof = this.window.end
    if (this.lineStart < eof) this.line(this.lineStart, eof, this.lineTooLong)
    this.closeFrom(0, eof, false)

    const root = this.root as MimeNode
    if (root.headers.length === 0) {
      throw new EmlParseError("Message has no headers")
    }
    return { root, nodes: this.nodes, limits: this.limits }
  }

  // --- lines --------------------------------------------------------------

  private line(start: number, end: number, tooLong: boolean): void {
    const raw = tooLong ? null : this.window.slice(start, end)
    // As the recursive splitter compared it: one trailing CRLF or LF off.
    const content = raw === null ? null : raw.replace(/\r?\n$/, "")

    // 1. A delimiter of an open multipart, outermost first.
    if (content !== null) {
      for (let depth = 0; depth < this.stack.length; depth++) {
        const open = this.stack[depth]
        if (open.phase !== "multipart" || open.closed || start < open.bodyStart) {
          continue
        }
        if (content !== open.delimiter && content !== `${open.delimiter}--`) {
          continue
        }
        this.delimiter(depth, open, content, start, end)
        return
      }
    }

    // 2. A part that has begun is known to exist once a line starts three
    //    bytes past it: whatever closes it now leaves it at least one byte.
    const top = this.stack[this.stack.length - 1]
    if (top.phase === "tentative" && start >= top.start + 3) this.create(top)

    // 3. The empty line that ends a header block. Creating the part above
    //    may have resolved it and opened a nested message, so the part this
    //    line belongs to is asked for again.
    const current = this.stack[this.stack.length - 1]
    if (
      current.phase === "headers" &&
      start - 1 >= current.start &&
      (raw === "\n" || raw === "\r\n")
    ) {
      this.resolve(current, end)
    }

    this.refuseEndlessHeaders(end - 2)
  }

  /**
   * Refuses a header block that is already certain to be too long, rather
   * than holding it to find out.
   *
   * With nothing found up to `reached`, the block ends either at an empty
   * line still to come or where the part does — and a part ends at most two
   * bytes before the next line that could close it. Either way no earlier
   * than `reached`, so past the limit from there it is past the limit, and
   * the recursive parser refused it at this same node.
   */
  private refuseEndlessHeaders(reached: number): void {
    const current = this.stack[this.stack.length - 1]
    if (
      current.phase === "headers" &&
      reached - current.start > this.limits.maxHeaderBytes
    ) {
      throw new EmlLimitError("maxHeaderBytes", this.limits.maxHeaderBytes)
    }
  }

  private delimiter(
    depth: number,
    multipart: Open,
    content: string,
    start: number,
    end: number
  ): void {
    if (multipart.partStart !== null) {
      // The line break before a delimiter belongs to the delimiter.
      let partEnd = start
      if (this.window.charAt(partEnd - 1) === "\n") partEnd -= 1
      if (this.window.charAt(partEnd - 1) === "\r") partEnd -= 1
      this.closeFrom(depth + 1, partEnd, true)
    }
    const closing = content.endsWith("--")
    multipart.partStart = closing ? null : end
    if (closing) {
      multipart.closed = true
      return
    }
    this.stack.push(
      this.open(
        "tentative",
        `${multipart.path}.${multipart.children + 1}`,
        multipart.depth + 1,
        multipart.nestedDepth,
        end
      )
    )
  }

  // --- nodes ----------------------------------------------------------------

  private open(
    phase: Phase,
    path: string,
    depth: number,
    nestedDepth: number,
    start: number
  ): Open {
    return {
      phase,
      path,
      depth,
      nestedDepth,
      start,
      node: null,
      bodyStart: start,
      delimiter: "",
      closed: false,
      partStart: null,
      children: 0,
    }
  }

  /** A part is known to exist: count it, and find its headers so far. */
  private create(open: Open): void {
    if (open.depth > this.limits.maxDepth) {
      throw new EmlLimitError("maxDepth", this.limits.maxDepth)
    }
    this.budget.parts += 1
    if (this.budget.parts > this.limits.maxParts) {
      throw new EmlLimitError("maxParts", this.limits.maxParts)
    }
    const parent = this.stack[this.stack.indexOf(open) - 1]
    if (parent?.phase === "multipart") parent.children += 1
    open.phase = "headers"

    // An empty line already past, while it was tentative.
    const blank = this.blankLineBefore(open.start, this.lineStart)
    if (blank !== null) this.resolve(open, blank)
  }

  /**
   * Where a header block ends, if its empty line lies before `limit`: the
   * first `\n` at or after `start` followed by `\n` or `\r\n`.
   */
  private blankLineBefore(start: number, limit: number): number | null {
    for (let index = start; index < limit; index++) {
      if (this.window.charAt(index) !== "\n") continue
      if (index + 2 <= limit && this.window.charAt(index + 1) === "\n") {
        return index + 2
      }
      if (
        index + 3 <= limit &&
        this.window.charAt(index + 1) === "\r" &&
        this.window.charAt(index + 2) === "\n"
      ) {
        return index + 3
      }
    }
    return null
  }

  /** The header block has ended at `bodyStart`: the node exists in full. */
  private resolve(open: Open, bodyStart: number): void {
    const { limits, budget } = this
    if (bodyStart - open.start > limits.maxHeaderBytes) {
      throw new EmlLimitError("maxHeaderBytes", limits.maxHeaderBytes)
    }

    const headers = this.headersOf(open.start, bodyStart)
    const node = describe(headers, open, bodyStart)
    open.node = node
    open.bodyStart = bodyStart
    this.nodes.push(node)
    if (open.path === "0") this.root = node

    const parent = this.stack[this.stack.indexOf(open) - 1]
    if (parent?.node) {
      if (parent.phase === "message") parent.node.nested = node
      else parent.node.children.push(node)
    }

    if (node.contentType.startsWith("multipart/") && node.boundary) {
      open.phase = "multipart"
      open.delimiter = `--${node.boundary}`
      return
    }

    if (node.contentType === "message/rfc822") {
      if (open.nestedDepth + 1 > limits.maxNestedMessages) {
        throw new EmlLimitError("maxNestedMessages", limits.maxNestedMessages)
      }
      open.phase = "message"
      // The recursive parser parsed a nested message unconditionally, so it
      // exists from here rather than being tentative.
      const nested = this.open(
        "tentative",
        `${open.path}.msg`,
        open.depth + 1,
        open.nestedDepth + 1,
        bodyStart
      )
      this.stack.push(nested)
      this.create(nested)
      return
    }

    if (isTextual(node.contentType) && node.disposition !== "attachment") {
      open.phase = "text"
      return
    }

    node.attachment = true
    open.phase = "attachment"
    budget.attachments += 1
    if (budget.attachments > limits.maxAttachments) {
      throw new EmlLimitError("maxAttachments", limits.maxAttachments)
    }
  }

  private headersOf(start: number, bodyStart: number): MimeHeader[] {
    if (bodyStart <= start) return []
    const block = this.window.slice(start, bodyStart)
    return parseHeaders(block, 0, block.length).map((header) => ({
      ...header,
      start: header.start + start,
      end: header.end + start,
      valueStart: header.valueStart + start,
      valueEnd: header.valueEnd + start,
    }))
  }

  /**
   * Closes every open node from `from` inwards at `end`.
   *
   * `byDelimiter` says the outermost of them was closed by its own
   * multipart's delimiter, which makes it exist however short it is. Every
   * other part that was still tentative exists only if it holds a byte.
   */
  private closeFrom(from: number, end: number, byDelimiter: boolean): void {
    // Innermost first: only the innermost can still owe a check, and its
    // checks come before its ancestors' in the recursive parser's order.
    while (this.stack.length > from) {
      const open = this.stack[this.stack.length - 1]
      const parent = this.stack[this.stack.length - 2]

      if (open.phase === "tentative") {
        const exists =
          (this.stack.length - 1 === from && byDelimiter) ||
          parent?.phase !== "multipart" ||
          open.start < end
        if (!exists) {
          this.stack.pop()
          continue
        }
        this.create(open)
      }
      if (open.phase === "headers") this.resolve(open, end)
      // Resolving may have opened a nested message, which closes here too.
      if (this.stack[this.stack.length - 1] !== open) continue

      this.finish(open, end)
      this.stack.pop()
    }
  }

  private finish(open: Open, end: number): void {
    const node = open.node as MimeNode
    node.end = end
    node.bodyEnd = end

    if (open.phase === "text") {
      const raw = open.bodyStart < end ? this.window.slice(open.bodyStart, end) : ""
      const decoded = decodeTransfer(raw, node.encoding)
      this.budget.textBytes += decoded.byteLength
      if (this.budget.textBytes > this.limits.maxTextBytes) {
        throw new EmlLimitError("maxTextBytes", this.limits.maxTextBytes)
      }
      node.text = decodeCharset(decoded, node.charset)
    }
  }

  // --- memory ---------------------------------------------------------------

  /** The longest line that could still be a delimiter. */
  private longestDelimiter(): number {
    let longest = 0
    for (const open of this.stack) {
      if (open.phase === "multipart" && !open.closed) {
        longest = Math.max(longest, open.delimiter.length + 2)
      }
    }
    return longest
  }

  /** The earliest offset anything still open needs to read back. */
  private needed(): number {
    // Two bytes behind the incomplete line, for the line break a delimiter
    // on it would take from the part before.
    let keep = this.lineStart - 2
    for (const open of this.stack) {
      if (open.phase === "tentative" || open.phase === "headers") {
        keep = Math.min(keep, open.start)
      } else if (open.phase === "text") {
        keep = Math.min(keep, open.bodyStart)
      }
    }
    return keep
  }

  /**
   * An incomplete line longer than any delimiter cannot become one, and if
   * nothing open needs its text — an attachment's body, say — only its last
   * two bytes are worth keeping.
   */
  private trimLongLine(): void {
    const length = this.window.end - this.lineStart
    if (length <= this.longestDelimiter() + 2) return
    this.lineTooLong = true
    const keeping = this.stack.some(
      (open) =>
        open.phase === "tentative" || open.phase === "headers" || open.phase === "text"
    )
    if (!keeping) this.window.release(this.window.end - 2)
  }

  private release(): void {
    this.window.release(Math.min(this.needed(), this.window.end - 2))
  }

  /**
   * Runs a step, holding back a limit broken before any content was seen:
   * the recursive parser reported an all-whitespace message as empty before
   * it parsed anything, so a limit its whitespace broke was never reached.
   */
  private guard(step: () => void): void {
    try {
      step()
    } catch (error) {
      if (!this.sawContent && error instanceof EmlLimitError) {
        this.deferred = error
        return
      }
      throw error
    }
  }
}

/** A node's description, from its headers, as the recursive parser made it. */
function describe(headers: MimeHeader[], open: Open, bodyStart: number): MimeNode {
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

  return {
    path: open.path,
    depth: open.depth,
    start: open.start,
    end: open.start,
    headers,
    bodyStart,
    bodyEnd: open.start,
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
}

/**
 * Parses a message as it streams, holding its structure and its text parts
 * and never its attachments. `onPiece` sees every piece as it passes, for a
 * caller hashing the source in the same read.
 */
export async function scanEml(
  source: AsyncIterable<Uint8Array>,
  limits: EmlLimits = emlLimits(),
  onPiece?: (piece: Uint8Array) => void
): Promise<ParsedMessage> {
  const scanner = new MimeScanner(limits)
  let failure: unknown = null
  for await (const piece of source) {
    onPiece?.(piece)
    // A refusal is held until the source has been read to the end, so a
    // caller verifying its checksum as it goes can report corruption first.
    if (failure) continue
    try {
      scanner.write(
        Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).toString("latin1")
      )
    } catch (error) {
      failure = error
    }
  }
  if (failure) throw failure
  return scanner.end()
}
