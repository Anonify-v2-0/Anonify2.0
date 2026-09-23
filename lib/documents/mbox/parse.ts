import { decodeEml, encodeEml, looksLikeEml } from "@/lib/documents/eml/parse"
import {
  mboxLimits,
  MboxLimitError,
  type MboxLimits,
} from "@/lib/documents/mbox/limits"
import { DETECTION_SAMPLE_BYTES } from "@/lib/documents/sample"
import type { ByteSource } from "@/lib/storage/streams"

/**
 * A mailbox, split back into the messages it is made of.
 *
 * This is deliberately not a new MIME problem. An MBOX file is a series of
 * RFC 822 messages with a `From ` line wedged between them, so the parser that
 * already exists — `lib/documents/eml/parse.ts`, a tree that knows its own byte
 * ranges — is the parser for every message in here. All this file does is find
 * the seams, and everything downstream then handles an ordinary message.
 *
 * Finding the seams is the entire difficulty, and it has one classic way of
 * going wrong. The separator is a line beginning `From `, and a line beginning
 * `From ` is also a thing people write in emails — "From the top", "From what
 * I can tell". Producers escape those as `>From `, but the escaping is a
 * convention rather than a guarantee, and a splitter that fractures a message
 * on a body line hands the reviewer two half-messages: the first missing its
 * ending, the second with a body where its headers should be and no `From:`
 * header at all. Neither is refused by anything downstream. Both look like
 * documents.
 *
 * So a candidate separator has to pass three tests, not one, and it is treated
 * as body text unless all three hold:
 *
 *   1. it is at the very start of the file, or the line before it is blank —
 *      which is what the format actually specifies;
 *   2. the line has the shape of a real `From ` line, address and asctime date
 *      and all, rather than merely the first five characters;
 *   3. the bytes immediately after it parse as a message header block.
 *
 * Failing any of them merges rather than splits, and that direction is chosen
 * on purpose: an over-merged mailbox is one visibly enormous message a reviewer
 * can see is wrong, and a fractured one is two plausible documents that are
 * each quietly missing half of the other.
 *
 * Bytes are Latin-1 here for the same reason they are in the MIME parser: one
 * character is one byte, so an offset is an offset and a message handed on is
 * the bytes that were actually in the file.
 *
 * And the mailbox is never one string. Every test is local — the line before,
 * the line itself, and a few kilobytes after — so the scan reads the file as
 * it streams out of storage and reports each message as a byte range. A
 * message is read out later, on its own, when it becomes a document.
 */

export class MboxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MboxParseError"
  }
}

/**
 * The shape of a separator line.
 *
 * `From `, then optionally the envelope sender — `dickens@example.com`,
 * `MAILER-DAEMON`, or the bare `-` Thunderbird writes — then an asctime date.
 * The date is what makes this a test rather than a prefix check: "From the top
 * of the report" has the first five characters and nothing after them that
 * could be mistaken for `Fri Jan  2 03:04:05 2026`.
 *
 * The tail is left open because the year, the timezone and the trailing
 * annotations vary by producer and none of them are load-bearing here.
 */
const SEPARATOR =
  /^From (?:\S+ +)?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{1,2}:\d{2}(?::\d{2})?(?:\s.*)?$/

/** How much of a file is read to decide whether it is a mailbox at all. */
const SNIFF_BYTES = 16 * 1024

/**
 * Whether these bytes are plausibly a mailbox.
 *
 * The same three tests the splitter uses, applied to the first message only.
 * A file whose first line is a `From ` line but which is not followed by
 * headers is not a mailbox — it is a text file that happens to start with a
 * sentence — and calling it one would take it away from the text pipeline that
 * can actually read it.
 */
export function looksLikeMbox(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("latin1")

  const breakAt = head.search(/\r?\n/)
  if (breakAt === -1) return false

  const fromLine = head.slice(0, breakAt)
  if (!SEPARATOR.test(fromLine)) return false

  const rest = head.slice(breakAt).replace(/^\r?\n/, "")
  // A prefix, so the tail may be truncated mid-header. `looksLikeEml` reads a
  // header block and stops at the first blank line, which a 16 KiB sample of a
  // real message reaches long before its end.
  return looksLikeEml(new Uint8Array(Buffer.from(rest, "latin1")))
}

/**
 * Undoes the quoting a producer applied on the way in.
 *
 * A body line that begins `From ` would be read back as a separator, so
 * mailbox writers prefix it with `>`; mboxrd, the reversible convention, does
 * the same to a line that already begins `>From `, which is what makes the
 * transformation something you can actually undo. Removing exactly one `>`
 * from any run reverses it.
 *
 * **What this does not claim.** The older mboxo convention escapes only
 * `From ` and leaves `>From ` alone, and the two are not distinguishable from
 * the bytes: `>>From ` is a genuinely twice-quoted line under mboxo and a
 * once-quoted one under mboxrd. Undoing it as mboxrd is the choice that
 * round-trips, and the cost when the guess is wrong is one `>` in quoted text.
 * It is stated here rather than left as a surprise, and it cannot cause a
 * value to be missed: the unquoted text is what the detectors read either way.
 */
export function unquoteFromLines(message: string): string {
  return message.replace(
    /(^|\n)(>+)(From )/g,
    (_all, start: string, quotes: string, from: string) =>
      `${start}${quotes.slice(1)}${from}`
  )
}

/**
 * Trims the blank line that terminates a message.
 *
 * The blank line before a separator belongs to the mailbox, not to the message
 * — it is how the format says "this one has ended". Carrying it into the child
 * would append an empty line to every message a mailbox ever produced, which
 * is a difference between an `.eml` extracted from here and the same `.eml`
 * off a desktop, and those two must be indistinguishable.
 *
 * One blank line, and only when there is one: the message's own final newline
 * is kept, because a file that does not end in a newline is a file somebody
 * will notice.
 */
function withoutTerminator(message: string): string {
  return message.replace(/(\r?\n)\r?\n$/, "$1")
}

// --- the scan -----------------------------------------------------------------

/**
 * How much of each message is kept while scanning: exactly what content
 * sniffing reads, so a message can be sniffed without being read back.
 */
const MESSAGE_HEAD_BYTES = DETECTION_SAMPLE_BYTES

/** One message, located in the mailbox but not read out of it. */
export type MailboxSpan = {
  /** Position in the mailbox, from zero. Stable across retries. */
  index: number
  /** The separator line this message was introduced by, without its newline. */
  fromLine: string
  /** Byte offset of the message's first header, in the mailbox. */
  start: number
  /** Byte offset just past the message's last byte, in the mailbox. */
  end: number
  /**
   * The message's length as it is handed on — terminating blank line trimmed,
   * `>From ` quoting undone — which is a little less than `end - start`.
   */
  size: number
}

/** A span as the scanner reports it, with the head of the message. */
export type ScannedMessage = MailboxSpan & {
  /** The first `DETECTION_SAMPLE_BYTES` of the message as it is handed on. */
  head: Buffer
}

/** One message, read out: separator gone, `>From ` quoting undone. */
export type MailboxEntry = MailboxSpan & {
  bytes: Uint8Array
}

type Line = {
  /** The line as it sits in the file, newline included when it has one. */
  text: string
  /** Absolute byte offset of the line's first byte. */
  offset: number
  /** Passed tests 1 and 2, and is waiting on test 3. */
  candidate: boolean
  /** Without its newline and one trailing CR: what the separator test reads. */
  content: string
}

type OpenMessage = {
  fromLine: string
  start: number
  size: number
  head: string[]
  headLength: number
  lines: number
  lastBlank: boolean
  lastLength: number
}

/**
 * Finds the seams in a mailbox as it streams past.
 *
 * The three tests above are all local, and that is what makes this possible
 * without the mailbox in memory: the blank line before a candidate and the
 * candidate's own shape are known the moment the line is complete, and the
 * header test needs only the next `SNIFF_BYTES` after it. So a candidate is
 * held until that much more has arrived, decided, and everything before the
 * next undecided candidate is settled into the message it belongs to.
 *
 * Each message is reported as a byte range with its final length and a head
 * for sniffing — never as bytes. Reading a message out is the caller's job,
 * one at a time, through a ranged read of the sealed source.
 *
 * The decisions are the ones the whole-string splitter made, byte for byte:
 * the tests read the same bytes, in the same order, against the same patterns.
 * What changed is how much of the file has to exist at once — the current
 * line, the lookahead window, and one head.
 */
export class MailboxScanner {
  private carry = ""
  private carryOffset = 0
  private consumed = 0
  private previous: { blank: boolean; offset: number } | null = null
  private readonly pending: Line[] = []
  private pendingBytes = 0
  private message: OpenMessage | null = null
  private separators = 0
  private emitted = 0
  private totalBytes = 0

  constructor(
    private readonly limits: MboxLimits,
    private readonly onMessage: (message: ScannedMessage) => void
  ) {}

  write(bytes: Uint8Array): void {
    const text = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength
    ).toString("latin1")
    const base = this.consumed
    this.consumed += text.length

    let cursor = 0
    let newline = text.indexOf("\n")
    while (newline !== -1) {
      if (cursor === 0 && this.carry.length > 0) {
        this.line(
          this.carry + text.slice(0, newline + 1),
          this.carryOffset,
          false
        )
        this.carry = ""
      } else {
        this.line(text.slice(cursor, newline + 1), base + cursor, false)
      }
      cursor = newline + 1
      newline = text.indexOf("\n", cursor)
    }

    if (cursor === 0) {
      // No line ended in this piece: it all belongs to the line in progress.
      if (this.carry.length === 0) this.carryOffset = base
      this.carry += text
    } else {
      this.carry = text.slice(cursor)
      this.carryOffset = base + cursor
    }

    this.decide(false)
  }

  /** Finishes the scan. Throws for a mailbox with no messages or over a limit. */
  end(): void {
    if (this.carry.length > 0) {
      // The last line, with no newline after it. It can never be a
      // separator — there is nothing after it to be a header block — so it
      // is body text of whatever message is open.
      const last = this.carry
      this.carry = ""
      this.line(last, this.carryOffset, true)
    }
    this.decide(true)
    this.close(this.consumed)

    if (this.separators === 0) {
      throw new MboxParseError("No messages found in this mailbox")
    }
    if (this.totalBytes > this.limits.maxTotalBytes) {
      throw new MboxLimitError("maxTotalBytes", this.limits.maxTotalBytes)
    }
  }

  private line(text: string, offset: number, final: boolean): void {
    const content = text.replace(/\n$/, "").replace(/\r$/, "")

    // Test 1: the start of the file, or a blank line before. A blank line that
    // is itself the first line of the file does not count — there has to be a
    // line ending before it for it to be one.
    const opensAfterBlank =
      offset === 0 ||
      (this.previous !== null &&
        this.previous.blank &&
        this.previous.offset > 0)
    // Test 2: the shape of a real separator line.
    const candidate =
      !final &&
      text.startsWith("From ") &&
      opensAfterBlank &&
      SEPARATOR.test(content)

    this.previous = { blank: text === "\n" || text === "\r\n", offset }

    if (!candidate && this.pending.length === 0) {
      this.settle(text, offset, content, false)
      return
    }
    this.pending.push({ text, offset, candidate, content })
    this.pendingBytes += text.length
  }

  /**
   * Decides every candidate that has enough lookahead behind it, and settles
   * the lines up to the next one that does not.
   */
  private decide(eof: boolean): void {
    while (this.pending.length > 0) {
      const head = this.pending[0]

      if (head.candidate) {
        const available =
          this.pendingBytes - head.text.length + this.carry.length
        if (available < SNIFF_BYTES && !eof) return

        // Test 3: the bytes after the separator's newline read as headers.
        let after = ""
        for (let index = 1; index < this.pending.length; index++) {
          after += this.pending[index].text
          if (after.length >= SNIFF_BYTES) break
        }
        if (after.length < SNIFF_BYTES) after += this.carry
        const opens = looksLikeEml(
          new Uint8Array(Buffer.from(after.slice(0, SNIFF_BYTES), "latin1"))
        )
        this.settle(head.text, head.offset, head.content, opens)
      } else {
        this.settle(head.text, head.offset, head.content, false)
      }

      this.pending.shift()
      this.pendingBytes -= head.text.length
    }
  }

  private settle(
    text: string,
    offset: number,
    content: string,
    separator: boolean
  ): void {
    if (separator) {
      this.close(offset)
      this.separators += 1
      // Counted as they are found, and refused the moment there are too
      // many. The refusal is about the mailbox, and nothing is built from a
      // scan that throws, so stopping early changes nothing but how long it
      // takes to say so.
      if (this.separators > this.limits.maxMessages) {
        throw new MboxLimitError("maxMessages", this.limits.maxMessages)
      }
      this.message = {
        fromLine: content,
        start: offset + text.length,
        size: 0,
        head: [],
        headLength: 0,
        lines: 0,
        lastBlank: false,
        lastLength: 0,
      }
      return
    }

    // Before the first separator there is no message to belong to, and those
    // bytes have never been handed on.
    const message = this.message
    if (!message) return

    // `>From ` quoting is undone per line, exactly as `unquoteFromLines`
    // undoes it over a whole message: at the start of every line.
    const handed = /^>+From /.test(text) ? text.slice(1) : text
    message.size += handed.length
    if (message.headLength < MESSAGE_HEAD_BYTES) {
      const piece = handed.slice(0, MESSAGE_HEAD_BYTES - message.headLength)
      message.head.push(piece)
      message.headLength += piece.length
    }
    message.lines += 1
    message.lastBlank = text === "\n" || text === "\r\n"
    message.lastLength = text.length
  }

  private close(end: number): void {
    const message = this.message
    if (!message) return
    this.message = null

    // `withoutTerminator`, in lengths: a blank last line after another line
    // is the mailbox's, not the message's.
    const size =
      message.lines >= 2 && message.lastBlank
        ? message.size - message.lastLength
        : message.size
    const head = Buffer.from(message.head.join(""), "latin1")

    this.totalBytes += size
    this.onMessage({
      index: this.emitted++,
      fromLine: message.fromLine,
      start: message.start,
      end,
      size,
      head: head.byteLength > size ? head.subarray(0, size) : head,
    })
  }
}

/**
 * Every message in a mailbox, located as it streams past.
 *
 * The whole-mailbox limits hold exactly as they did for the whole-string
 * split: the count is refused as soon as it is exceeded, the total bytes once
 * the scan has seen them all, and a mailbox with no messages at all is an
 * error rather than an empty batch. A partial split is never the outcome.
 */
export async function scanMailbox(
  source: ByteSource,
  limits: MboxLimits,
  onMessage: (message: ScannedMessage) => void
): Promise<void> {
  const scanner = new MailboxScanner(limits, onMessage)
  for await (const piece of source) scanner.write(piece)
  scanner.end()
}

/**
 * One message's bytes, from the raw range the scanner located.
 *
 * The two steps the scanner accounted for in lengths — trim the terminating
 * blank line, undo the `>From ` quoting — applied to the bytes.
 */
export function messageFromMailbox(raw: Uint8Array): Uint8Array {
  return encodeEml(unquoteFromLines(withoutTerminator(decodeEml(raw))))
}

/**
 * Every message in a mailbox held in memory, read out.
 *
 * For the callers that have the whole mailbox anyway — the tests, and the
 * verification in lib/documents/mbox/validate.ts. The pipeline itself scans a
 * stream and reads each message back through a ranged read instead.
 */
export function splitMailbox(
  source: string,
  limits: MboxLimits = mboxLimits()
): MailboxEntry[] {
  const spans: ScannedMessage[] = []
  const scanner = new MailboxScanner(limits, (message) => spans.push(message))
  scanner.write(Buffer.from(source, "latin1"))
  scanner.end()

  return spans.map(({ index, fromLine, start, end, size }) => {
    const bytes = messageFromMailbox(
      Buffer.from(source.slice(start, end), "latin1")
    )
    if (bytes.byteLength !== size) {
      // The scan's arithmetic and the bytes disagree. Nothing downstream
      // could notice, so this is the one place that can.
      throw new Error("Mailbox scan disagrees with the message it located")
    }
    return { index, fromLine, start, end, size, bytes }
  })
}

/** The mailbox's messages, read straight from the sealed bytes. */
export function readMailbox(
  bytes: Uint8Array,
  limits?: MboxLimits
): MailboxEntry[] {
  return splitMailbox(decodeEml(bytes), limits)
}
