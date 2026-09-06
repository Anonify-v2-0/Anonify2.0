import { decodeEml, encodeEml, looksLikeEml } from "@/lib/documents/eml/parse"
import {
  mboxLimits,
  MboxLimitError,
  type MboxLimits,
} from "@/lib/documents/mbox/limits"

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
 */

export class MboxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MboxParseError"
  }
}

/** One message, as it sits in the mailbox. */
export type MailboxEntry = {
  /** Position in the mailbox, from zero. Stable across retries. */
  index: number
  /** The separator line this message was introduced by, without its newline. */
  fromLine: string
  /** Byte offset of the message's first header, in the mailbox. */
  start: number
  /** Byte offset just past the message's last byte, in the mailbox. */
  end: number
  /** The message itself: separator gone, `>From ` quoting undone. */
  bytes: Uint8Array
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
 * Every line that begins `From `, and nothing else.
 *
 * A mailbox is millions of lines and a few hundred separators, so the cheap
 * five-character test is what the scan is built around: `indexOf` walks the
 * string once and the expensive checks only ever see a candidate.
 */
function candidateOffsets(source: string): number[] {
  const offsets: number[] = []
  if (source.startsWith("From ")) offsets.push(0)

  for (
    let at = source.indexOf("\nFrom ");
    at !== -1;
    at = source.indexOf("\nFrom ", at + 1)
  ) {
    offsets.push(at + 1)
  }

  return offsets
}

/**
 * Whether the line beginning at `offset` opens a new message.
 *
 * The blank-line rule is checked against the raw bytes rather than against a
 * line index so that both line endings behave the same: a mailbox written with
 * CRLF and one written with LF are the same file to everyone but a parser that
 * split on the wrong one.
 */
function opensMessage(source: string, offset: number, line: string): boolean {
  if (!SEPARATOR.test(line)) return false

  // The first line of the file needs no blank line before it; every other
  // separator does, and a `From ` line inside a body almost never has one.
  // Four bytes back, because a blank line is `\r\n\r\n` and two would let the
  // ordinary `\r\n` ending any line at all pass for one.
  if (offset > 0) {
    const preceding = source.slice(Math.max(0, offset - 4), offset)
    if (!/(?:\r?\n)\r?\n$/.test(preceding)) return false
  }

  const bodyStart = offset + line.length
  const afterNewline = source.slice(bodyStart).replace(/^\r?\n/, "")
  return looksLikeEml(
    new Uint8Array(Buffer.from(afterNewline.slice(0, SNIFF_BYTES), "latin1"))
  )
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

/**
 * Every message in a mailbox, in the order it sits in the file.
 *
 * The whole-mailbox limits are checked over the finished list rather than
 * while walking it, because a partial split is the one outcome that is not on
 * the table: stopping at the two hundredth message of nine hundred produces a
 * batch that looks complete and is not.
 */
export function splitMailbox(
  source: string,
  limits: MboxLimits = mboxLimits()
): MailboxEntry[] {
  const separators: { offset: number; line: string }[] = []

  for (const offset of candidateOffsets(source)) {
    const newline = source.indexOf("\n", offset)
    const line = (
      newline === -1 ? source.slice(offset) : source.slice(offset, newline)
    ).replace(/\r$/, "")

    if (opensMessage(source, offset, line)) separators.push({ offset, line })
  }

  if (separators.length === 0) {
    throw new MboxParseError("No messages found in this mailbox")
  }

  // Counted before anything is built. The refusal is about the mailbox, and a
  // reviewer must never be handed the first two hundred of it instead.
  if (separators.length > limits.maxMessages) {
    throw new MboxLimitError("maxMessages", limits.maxMessages)
  }

  const entries: MailboxEntry[] = []

  for (const [index, separator] of separators.entries()) {
    const newline = source.indexOf("\n", separator.offset)
    // A separator with nothing after it is a truncated mailbox: the message it
    // introduces is not there, so there is nothing to make a document out of.
    if (newline === -1) continue

    const start = newline + 1
    const end = separators[index + 1]?.offset ?? source.length
    const message = unquoteFromLines(
      withoutTerminator(source.slice(start, end))
    )

    entries.push({
      index: entries.length,
      fromLine: separator.line,
      start,
      end,
      bytes: encodeEml(message),
    })
  }

  const total = entries.reduce((sum, entry) => sum + entry.bytes.byteLength, 0)
  if (total > limits.maxTotalBytes) {
    throw new MboxLimitError("maxTotalBytes", limits.maxTotalBytes)
  }

  return entries
}

/** The mailbox's messages, read straight from the sealed bytes. */
export function readMailbox(
  bytes: Uint8Array,
  limits?: MboxLimits
): MailboxEntry[] {
  return splitMailbox(decodeEml(bytes), limits)
}
