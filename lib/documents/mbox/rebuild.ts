import { createHash } from "node:crypto"
import { Readable } from "node:stream"

import type { MboxLimits } from "@/lib/documents/mbox/limits"
import {
  MailboxScanner,
  messageFromMailbox,
  type ScannedMessage,
} from "@/lib/documents/mbox/parse"
import { ChecksumVerifier, checksumMatches } from "@/lib/storage/integrity"
import { ByteQueue, chain, readHead } from "@/lib/storage/streams"

/**
 * A mailbox, put back together from its redacted messages.
 *
 * Upload takes a mailbox apart: one document per message, each reviewed and
 * exported on its own. This is the other direction, and it is deliberately
 * not a second redactor. Every message that goes in is a message export that
 * has already been verified on its own — its bytes, checked against the
 * checksum recorded when it passed — so the only things this file writes are
 * the three things a mailbox has that a message does not:
 *
 *   - **the `From ` separator line**, which is personal data in the source: it
 *     carries the envelope sender and the time the message arrived. It is
 *     therefore never copied. The sender is always `MAILER-DAEMON`, and the
 *     date is the redacted message's own `Date:` header — something the
 *     reviewer has already seen survive, in the file they are downloading —
 *     or a fixed placeholder when that header is missing, unreadable, or would
 *     put an accepted value on the line;
 *   - **`>From ` quoting**, reapplied as mboxrd: one more `>` on every line
 *     matching `^>*From `, which is the one convention that the splitter's
 *     unquoting reverses exactly;
 *   - **the blank line** that ends each message.
 *
 * And then it is verified the way every other export is, by reading it back
 * as an adversary would — here, with the very scanner that splits an upload.
 * The rebuilt mailbox must split into exactly the messages that went in, each
 * equal byte for byte to what went in, with no accepted value on any separator
 * line. Between them those account for every byte of the file: a byte is
 * either inside a message that is a verified export, or on a line this code
 * wrote and then searched.
 *
 * Built as it is written, never held: each message is streamed out of storage,
 * quoted a piece at a time and handed on. The verifier holds one message at a
 * time — the same bound expansion works within when it reads one message out
 * of an uploaded mailbox — and a delivery is the same bytes again, checked
 * against the checksum the verification pass computed.
 */

/** The envelope sender every rebuilt separator carries. Nobody's address. */
export const REBUILT_SENDER = "MAILER-DAEMON"

/**
 * The separator for a message whose own date cannot be used.
 *
 * The epoch, in asctime, which every mailbox reader accepts and nobody will
 * mistake for when a message actually arrived.
 */
export const PLACEHOLDER_SEPARATOR = `From ${REBUILT_SENDER} Thu Jan  1 00:00:00 1970`

/**
 * How much of a message is read before its separator is written.
 *
 * Enough for a header block with a long `Received:` chain in front of the
 * `Date:`. A date further in than this is treated as missing, which costs a
 * placeholder and never a leak.
 */
const HEAD_BYTES = 64 * 1024

/**
 * Values shorter than this are not searched for, for the reason the export
 * verifier gives: they appear by coincidence. Kept equal to it on purpose.
 */
const MIN_SEARCHED_LENGTH = 4

/**
 * One message to go into a mailbox.
 *
 * `checksum` is what the message's export recorded when it passed
 * verification. The bytes are hashed as they stream and a mismatch refuses the
 * mailbox, exactly as a mismatch breaks off a single download.
 */
export type RebuildMessage = {
  open: () => Promise<AsyncIterable<Uint8Array>>
  checksum: string
}

/** Why a rebuilt mailbox was refused. Never a value, never a subject. */
export type MailboxRebuildFailure =
  /** A message's bytes did not match the checksum its export recorded. */
  | "artifact-mismatch"
  /** The rebuilt mailbox did not split into as many messages as went in. */
  | "count-mismatch"
  /** A message read back out of the mailbox is not the message that went in. */
  | "message-mismatch"
  /** An accepted value, or a line this code did not write, on a separator. */
  | "separator-leak"

export class MailboxRebuildError extends Error {
  constructor(
    readonly failure: MailboxRebuildFailure,
    /** Zero-based position of the message it concerns, when there is one. */
    readonly index: number | null = null
  ) {
    super(`The rebuilt mailbox failed verification: ${failure}`)
    this.name = "MailboxRebuildError"
  }
}

/** What the verification pass established, for the delivery pass to hold to. */
export type RebuiltMailbox = {
  /** SHA-256 of the whole rebuilt mailbox. */
  checksum: string
  size: number
  /** How many messages it holds, counted by re-scanning it. */
  messages: number
}

// --- the separator ----------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/** `Thu Jan  1 00:00:00 1970`: the date shape a separator line takes. */
export function asctime(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0")
  return [
    DAYS[date.getUTCDay()],
    MONTHS[date.getUTCMonth()],
    String(date.getUTCDate()).padStart(2, " "),
    `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`,
    String(date.getUTCFullYear()),
  ].join(" ")
}

/**
 * The `Date:` header of a message, from the head of its bytes.
 *
 * Only the header block is read, and only a date that parses to a real,
 * four-digit-year instant is used. Anything else — a header the reviewer
 * redacted, a surrogate that is not a date, a header past the head — is
 * missing, and missing is the placeholder.
 */
export function messageDate(head: Uint8Array): Date | null {
  const text = Buffer.from(
    head.buffer,
    head.byteOffset,
    head.byteLength
  ).toString("latin1")
  const blank = text.search(/\r?\n\r?\n/)
  const block = (blank === -1 ? text : text.slice(0, blank)).replace(
    /\r?\n[ \t]+/g,
    " "
  )

  const match = /^date:[ \t]*(.+)$/im.exec(block)
  if (!match) return null

  const parsed = Date.parse(match[1].trim())
  if (!Number.isFinite(parsed)) return null

  const date = new Date(parsed)
  const year = date.getUTCFullYear()
  return year >= 1970 && year <= 9999 ? date : null
}

/** The values a separator line must not carry, lowercased and deduplicated. */
export function searchedValues(values: Iterable<string>): string[] {
  const kept = new Set<string>()
  for (const value of values) {
    const trimmed = value.trim().toLowerCase()
    if (trimmed.length >= MIN_SEARCHED_LENGTH) kept.add(trimmed)
  }
  return [...kept]
}

function carriesAny(line: string, values: string[]): boolean {
  const haystack = line.toLowerCase()
  return values.some((value) => haystack.includes(value))
}

/**
 * The separator for one message, from the head of its redacted bytes.
 *
 * Never from the source's own separator, which this code is never even handed.
 * `values` are the accepted values already lowercased by `searchedValues`; a
 * line that would carry one falls back to the placeholder, and a placeholder
 * that would carry one is still written — and refused by the verifier, which
 * is where that decision belongs.
 */
export function separatorFor(head: Uint8Array, values: string[]): string {
  const date = messageDate(head)
  if (date) {
    const line = `From ${REBUILT_SENDER} ${asctime(date)}`
    if (!carriesAny(line, values)) return line
  }
  return PLACEHOLDER_SEPARATOR
}

// --- quoting ----------------------------------------------------------------

const GT = 0x3e
const LF = 0x0a
const FROM = Buffer.from("From ", "latin1")
const QUOTE = Buffer.from(">", "latin1")
const EMPTY = Buffer.alloc(0)

/** Whether the line starting at `start` is `^>*From `, or it cannot tell yet. */
function fromLineAt(data: Buffer, start: number): "yes" | "no" | "undecided" {
  let cursor = start
  while (cursor < data.length && data[cursor] === GT) cursor += 1

  for (let index = 0; index < FROM.length; index++) {
    if (cursor + index >= data.length) return "undecided"
    if (data[cursor + index] !== FROM[index]) return "no"
  }
  return "yes"
}

/**
 * mboxrd quoting, a piece at a time.
 *
 * Every line that begins with any run of `>` followed by `From ` gets one more
 * `>`. That is a superset of what a separator could be mistaken for, and it is
 * the exact inverse of `unquoteFromLines`, which takes one `>` back off the
 * same lines — so a message quoted here and read back by the splitter is the
 * message that went in.
 *
 * A line whose start straddles two pieces is held until it can be decided;
 * nothing else is held.
 */
export class FromQuoter {
  private pending: Buffer = EMPTY
  private lineStart = true

  push(piece: Uint8Array): Buffer[] {
    const incoming = Buffer.from(
      piece.buffer,
      piece.byteOffset,
      piece.byteLength
    )
    const data =
      this.pending.length > 0
        ? Buffer.concat([this.pending, incoming])
        : incoming
    this.pending = EMPTY

    const out: Buffer[] = []
    let emitted = 0
    let cursor = 0

    while (cursor < data.length) {
      if (this.lineStart) {
        const verdict = fromLineAt(data, cursor)
        if (verdict === "undecided") {
          if (cursor > emitted) out.push(data.subarray(emitted, cursor))
          // Copied: the piece it came from belongs to whoever handed it in.
          this.pending = Buffer.from(data.subarray(cursor))
          return out
        }
        if (verdict === "yes") {
          if (cursor > emitted) out.push(data.subarray(emitted, cursor))
          out.push(QUOTE)
          emitted = cursor
        }
        this.lineStart = false
      }

      const newline = data.indexOf(LF, cursor)
      if (newline === -1) break
      cursor = newline + 1
      this.lineStart = true
    }

    if (data.length > emitted) out.push(data.subarray(emitted))
    return out
  }

  /** The end of the message: a held line start that never became `From `. */
  end(): Buffer[] {
    const rest = this.pending
    this.pending = EMPTY
    this.lineStart = true
    return rest.length > 0 ? [rest] : []
  }
}

// --- writing ----------------------------------------------------------------

/** What went into the mailbox for one message, for the verifier to hold to. */
type Framed = {
  /** SHA-256 of the message as the splitter must hand it back. */
  checksum: string
}

function asBuffer(piece: Uint8Array): Buffer {
  return Buffer.isBuffer(piece)
    ? piece
    : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)
}

/**
 * The mailbox, as bytes, as it is written.
 *
 * For each message: its separator, its bytes quoted, and the blank line that
 * ends it. A message whose last line has no line ending is given one — the
 * format has no way to end a message otherwise — and the verifier is told, so
 * that what it holds the message to is exactly what was written.
 *
 * Each message's bytes are hashed as they pass and held to the checksum its
 * export recorded. A mismatch throws after the message, which fails a
 * verification pass outright and breaks off a delivery that is already
 * checked end to end.
 */
export async function* writeMailbox(
  messages: RebuildMessage[],
  options: {
    /** Accepted values, as `searchedValues` returns them. */
    values: string[]
    onMessage?: (framed: Framed) => void
  }
): AsyncGenerator<Buffer> {
  for (const [index, message] of messages.entries()) {
    const { head, rest } = await readHead(await message.open(), HEAD_BYTES)

    yield Buffer.from(`${separatorFor(head, options.values)}\n`, "latin1")

    const quoter = new FromQuoter()
    const recorded = createHash("sha256")
    const framed = createHash("sha256")
    let last = -1
    let beforeLast = -1

    const pass = (piece: Buffer): Buffer[] => {
      if (piece.length === 0) return []
      recorded.update(piece)
      framed.update(piece)
      beforeLast = piece.length >= 2 ? piece[piece.length - 2] : last
      last = piece[piece.length - 1]
      return quoter.push(piece)
    }

    yield* pass(head)
    for await (const piece of rest) yield* pass(asBuffer(piece))
    yield* quoter.end()

    if (!checksumMatches(message.checksum, recorded.digest("hex"))) {
      throw new MailboxRebuildError("artifact-mismatch", index)
    }

    let ending: Buffer
    if (last === LF) {
      ending = Buffer.from(beforeLast === 0x0d ? "\r\n" : "\n", "latin1")
    } else {
      ending = Buffer.from("\n", "latin1")
      framed.update(ending)
      yield ending
    }

    // The blank line that ends a message, in the message's own line ending so
    // a CRLF message stays CRLF to the end.
    yield ending
    options.onMessage?.({ checksum: framed.digest("hex") })
  }
}

// --- reading it back --------------------------------------------------------

/**
 * No limit of the upload's applies to reading back a mailbox this code wrote:
 * what is being checked is the count, exactly, not whether it is acceptable.
 */
const UNBOUNDED: MboxLimits = {
  maxMessages: Number.MAX_SAFE_INTEGER,
  maxTotalBytes: Number.MAX_SAFE_INTEGER,
  maxMessageBytes: Number.MAX_SAFE_INTEGER,
  maxDepth: Number.MAX_SAFE_INTEGER,
}

/** One message as the splitter found it in the rebuilt mailbox. */
export type RescannedMessage = {
  fromLine: string
  checksum: string
  size: number
}

/**
 * The rebuilt mailbox, split the way an upload is split.
 *
 * `MailboxScanner` is the splitter the pipeline uses on a mailbox somebody
 * uploads, and nothing else, so this is not a second opinion from friendlier
 * code: it is the same reading that decided where the source's messages
 * were, applied to what is about to leave. Each message it reports is read
 * out of the bytes the way expansion reads one — separator gone, terminator
 * trimmed, quoting undone — and hashed. Nothing before the message it is
 * reading is kept.
 */
export class MailboxReader {
  private readonly scanner: MailboxScanner
  private readonly queue = new ByteQueue()
  /** Offset in the mailbox of the first byte still queued. */
  private base = 0
  private readonly found: RescannedMessage[] = []

  constructor() {
    this.scanner = new MailboxScanner(UNBOUNDED, (message) =>
      this.read(message)
    )
  }

  write(bytes: Uint8Array): void {
    // Queued first: the scanner reports a message as soon as it can decide
    // where it ends, which may be during this very write.
    this.queue.push(bytes)
    this.scanner.write(bytes)
  }

  end(): RescannedMessage[] {
    this.scanner.end()
    return this.found
  }

  private read(message: ScannedMessage): void {
    this.queue.take(message.start - this.base)
    const raw = this.queue.take(message.end - message.start)
    this.base = message.end

    const bytes = messageFromMailbox(raw)
    this.found.push({
      fromLine: message.fromLine,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    })
  }
}

/**
 * Holds a re-scan to what was written.
 *
 * Exported on its own so the refusals can be tested against a mailbox that
 * was tampered with after it was written, which is the case the checks exist
 * for and one `buildVerifiedMailbox` cannot produce.
 */
export function assertRebuilt(
  found: RescannedMessage[],
  framed: Framed[],
  values: string[]
): void {
  if (found.length !== framed.length) {
    throw new MailboxRebuildError("count-mismatch")
  }

  for (const [index, message] of found.entries()) {
    // Ours, and nothing but ours: the sender this code writes, and none of
    // the values the reviewer accepted anywhere in the mailbox.
    if (
      !message.fromLine.startsWith(`From ${REBUILT_SENDER} `) ||
      carriesAny(message.fromLine, values)
    ) {
      throw new MailboxRebuildError("separator-leak", index)
    }
    if (!checksumMatches(framed[index].checksum, message.checksum)) {
      throw new MailboxRebuildError("message-mismatch", index)
    }
  }
}

/**
 * Builds the mailbox once, reading it back as it goes, and keeps nothing.
 *
 * The verification pass. What it returns is a checksum and a count; the bytes
 * went through the verifier and a hash and are gone. `streamRebuiltMailbox`
 * then writes them again for delivery and holds them to that checksum, so
 * what leaves is provably what was verified — the same two-pass shape the
 * batch archive already has.
 */
export async function buildVerifiedMailbox(
  messages: RebuildMessage[],
  values: string[]
): Promise<RebuiltMailbox> {
  if (messages.length === 0) {
    throw new MailboxRebuildError("count-mismatch")
  }

  const framed: Framed[] = []
  const reader = new MailboxReader()
  const hash = createHash("sha256")
  let size = 0

  for await (const piece of writeMailbox(messages, {
    values,
    onMessage: (message) => framed.push(message),
  })) {
    hash.update(piece)
    size += piece.byteLength
    reader.write(piece)
  }

  assertRebuilt(reader.end(), framed, values)

  return { checksum: hash.digest("hex"), size, messages: framed.length }
}

/**
 * The verified mailbox, written again for delivery.
 *
 * Deterministic — the same messages produce the same bytes — and checked
 * against the verification pass's checksum as it goes, so a message that
 * changed in between breaks the download off rather than completing it.
 */
export function streamRebuiltMailbox(
  messages: RebuildMessage[],
  values: string[],
  verified: RebuiltMailbox,
  onMismatch?: () => void
): Readable {
  return chain(
    Readable.from(writeMailbox(messages, { values }), { objectMode: false }),
    new ChecksumVerifier(verified.checksum, onMismatch)
  )
}
