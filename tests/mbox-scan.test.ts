import { describe, expect, it } from "vitest"

import { decodeEml, encodeEml, looksLikeEml } from "@/lib/documents/eml/parse"
import { mboxLimits, MboxLimitError } from "@/lib/documents/mbox/limits"
import { scanMailboxMessages } from "@/lib/documents/mbox/messages"
import {
  MailboxScanner,
  MboxParseError,
  messageFromMailbox,
  unquoteFromLines,
  type ScannedMessage,
} from "@/lib/documents/mbox/parse"

import { simpleEml } from "./eml-fixtures"
import {
  bodylessMessage,
  fromLine,
  mailbox,
  mailboxOf,
  numberedMessage,
  quotingHazardMessage,
} from "./mbox-fixtures"

/**
 * The streaming scanner, held to the splitter it replaced.
 *
 * The mailbox used to be split as one string: every candidate separator was
 * found with `indexOf` and judged against the bytes around it. The scanner
 * makes the same three judgements from a line and a window of lookahead, as
 * the file streams past in pieces of whatever size storage hands over. Those
 * two must agree on every seam, every byte range and every message, for every
 * way the file can be cut into pieces — a disagreement is a message fractured
 * or merged on the way to becoming a document, which is the failure the whole
 * mailbox format is organised around.
 *
 * So the old splitter lives on here, verbatim, as the reference; and the
 * scanner is fed the same mailboxes whole, a byte at a time, and in random
 * cuts, and must produce exactly what it produced.
 */

// --- the splitter this replaced, verbatim ----------------------------------------

const SEPARATOR =
  /^From (?:\S+ +)?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}\d{1,2} \d{1,2}:\d{2}(?::\d{2})?(?:\s.*)?$/
const SNIFF_BYTES = 16 * 1024

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

function opensMessage(source: string, offset: number, line: string): boolean {
  if (!SEPARATOR.test(line)) return false
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

function withoutTerminator(message: string): string {
  return message.replace(/(\r?\n)\r?\n$/, "$1")
}

type ReferenceEntry = {
  index: number
  fromLine: string
  start: number
  end: number
  bytes: Uint8Array
}

function referenceSplit(source: string): ReferenceEntry[] | string {
  const limits = mboxLimits()
  const separators: { offset: number; line: string }[] = []
  for (const offset of candidateOffsets(source)) {
    const newline = source.indexOf("\n", offset)
    const line = (
      newline === -1 ? source.slice(offset) : source.slice(offset, newline)
    ).replace(/\r$/, "")
    if (opensMessage(source, offset, line)) separators.push({ offset, line })
  }
  if (separators.length === 0) return "No messages found in this mailbox"
  if (separators.length > limits.maxMessages) return "maxMessages"

  const entries: ReferenceEntry[] = []
  for (const [index, separator] of separators.entries()) {
    const newline = source.indexOf("\n", separator.offset)
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
  return entries
}

// --- the scanner, fed in pieces --------------------------------------------------

type Scanned = Omit<ScannedMessage, "head"> & { head: string; bytes: string }

function scanInPieces(source: string, cuts: number[]): Scanned[] | string {
  const bytes = Buffer.from(source, "latin1")
  const found: ScannedMessage[] = []
  const scanner = new MailboxScanner(mboxLimits(), (message) =>
    found.push(message)
  )
  try {
    let at = 0
    for (const cut of [...cuts, bytes.byteLength]) {
      if (cut <= at) continue
      scanner.write(bytes.subarray(at, Math.min(cut, bytes.byteLength)))
      at = Math.min(cut, bytes.byteLength)
    }
    scanner.end()
  } catch (error) {
    if (error instanceof MboxParseError) return error.message
    if (error instanceof MboxLimitError) return error.limit
    throw error
  }
  return found.map((message) => ({
    ...message,
    head: message.head.toString("latin1"),
    bytes: decodeEml(
      messageFromMailbox(bytes.subarray(message.start, message.end))
    ),
  }))
}

/** What the reference said, in the scanner's shape, for comparison. */
function expected(source: string): Scanned[] | string {
  const reference = referenceSplit(source)
  if (typeof reference === "string") return reference
  return reference.map((entry) => {
    const message = decodeEml(entry.bytes)
    return {
      index: entry.index,
      fromLine: entry.fromLine,
      start: entry.start,
      end: entry.end,
      size: entry.bytes.byteLength,
      head: message.slice(0, 64 * 1024),
      bytes: message,
    }
  })
}

function everyByte(length: number): number[] {
  return Array.from({ length }, (_, index) => index + 1)
}

/** A seeded generator, so a failure names a case that can be run again. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomCuts(length: number, next: () => number): number[] {
  const cuts: number[] = []
  let at = 0
  while (at < length) {
    // Mostly small pieces, now and then a large one, so boundaries land
    // everywhere: inside a CRLF, inside a separator, inside the lookahead.
    at +=
      next() < 0.8
        ? 1 + Math.floor(next() * 40)
        : 1 + Math.floor(next() * 20_000)
    cuts.push(at)
  }
  return cuts
}

function assertAgrees(source: string, seed = 1): void {
  const want = expected(source)
  expect(scanInPieces(source, [])).toEqual(want)
  expect(scanInPieces(source, randomCuts(source.length, random(seed)))).toEqual(
    want
  )
  expect(
    scanInPieces(source, randomCuts(source.length, random(seed + 1)))
  ).toEqual(want)
}

// --- cases -------------------------------------------------------------------------

const LF = (text: string) => text.replace(/\r\n/g, "\n")

describe("the streaming mailbox scanner", () => {
  it("agrees with the whole-string splitter on an ordinary mailbox", () => {
    assertAgrees(mailboxOf(5))
    assertAgrees(LF(mailboxOf(5)))
  })

  it("agrees when fed one byte at a time", () => {
    const source = mailbox([
      numberedMessage(1),
      quotingHazardMessage(),
      bodylessMessage(3),
    ])
    expect(scanInPieces(source, everyByte(source.length))).toEqual(
      expected(source)
    )
  })

  it("agrees about body lines that look like separators", () => {
    // Every way a `From ` line can fail one test and pass the others.
    const hazards = [
      // Right shape, no blank line before it.
      `Subject: a\r\n\r\nline\r\n${fromLine()}\r\nFrom: someone@example.com\r\n\r\nbody\r\n`,
      // Blank line before it, wrong shape.
      `Subject: b\r\n\r\nline\r\n\r\nFrom the top of the report\r\n`,
      // Blank line and right shape, but no header block behind it.
      `Subject: c\r\n\r\nline\r\n\r\n${fromLine()}\r\njust prose after it\r\n`,
      // Quoted, once and twice.
      `Subject: d\r\n\r\n>From the start\r\n>>From further in\r\n`,
    ]
    const source = mailbox([numberedMessage(1), ...hazards, numberedMessage(2)])
    assertAgrees(source)
    assertAgrees(LF(source), 7)
  })

  it("agrees about what comes before the first separator", () => {
    const source = `stray preamble\r\n\r\n${mailbox([numberedMessage(1), numberedMessage(2)])}`
    assertAgrees(source)
  })

  it("agrees about a blank first line, which is not a blank line before anything", () => {
    assertAgrees(`\n${mailbox([numberedMessage(1)])}`)
    assertAgrees(`\r\n${mailbox([numberedMessage(1)])}`)
  })

  it("agrees about a mailbox that ends without a newline, or with a separator", () => {
    const source = mailbox([numberedMessage(1), numberedMessage(2)])
    assertAgrees(source.replace(/\r?\n$/, ""))
    assertAgrees(`${source}\r\n${fromLine()}`)
    assertAgrees(`${source}\r\n${fromLine()}\r\n`)
  })

  it("agrees when a separator's header block is far behind it", () => {
    // Test 3 reads a window after the separator; a piece boundary inside it,
    // and a window that runs past the end of the file, are both ordinary.
    const long = `Subject: long\r\n\r\n${"x".repeat(70)}\r\n`.repeat(600)
    const source = mailbox([long, numberedMessage(2), long, numberedMessage(4)])
    assertAgrees(source, 11)
  })

  it("agrees about a message whose head is longer than the sniffing window", () => {
    const huge = `Subject: huge\r\n\r\n${"y".repeat(100_000)}\r\n`
    assertAgrees(mailbox([huge, numberedMessage(2)]), 3)
  })

  it("agrees about odd line endings", () => {
    const source = mailbox([numberedMessage(1), numberedMessage(2)])
    assertAgrees(source.replace(/\r\n/g, "\r\r\n"))
    assertAgrees(source.replace(/\r\n\r\n/g, "\n\r\n"))
    assertAgrees(source.replace(/\r\n\r\n/g, "\r\n\n"))
  })

  it("refuses a file with no messages exactly as the splitter did", () => {
    expect(scanInPieces("Just some notes.\r\nNothing else.\r\n", [3, 9])).toBe(
      "No messages found in this mailbox"
    )
    expect(scanInPieces("", [])).toBe("No messages found in this mailbox")
  })

  it("agrees on randomly assembled mailboxes, cut at random", () => {
    const parts = [
      () => numberedMessage(1),
      () => quotingHazardMessage(),
      () => bodylessMessage(2),
      () => simpleEml(),
      () => `Subject: tiny\r\n\r\n`,
      () => `Subject: tail\r\n\r\n${fromLine()}\r\n`,
      () =>
        `Subject: q\r\n\r\n>>>From here\r\nFrom there\r\n\r\nFrom anywhere\r\n`,
    ]
    for (let seed = 1; seed <= 60; seed++) {
      const next = random(seed)
      const count = 1 + Math.floor(next() * 6)
      const messages = Array.from({ length: count }, () =>
        parts[Math.floor(next() * parts.length)]()
      )
      let source = mailbox(messages)
      if (next() < 0.3) source = LF(source)
      if (next() < 0.2) source = source.replace(/\r?\n$/, "")
      assertAgrees(source, seed * 13)
    }
  })

  it("reports each message's size and head without reading it out", async () => {
    const source = mailbox([numberedMessage(1), quotingHazardMessage()])
    const bytes = Buffer.from(source, "latin1")
    const found = await scanMailboxMessages(
      (function* () {
        for (let at = 0; at < bytes.byteLength; at += 5) {
          yield bytes.subarray(at, at + 5)
        }
      })()
    )

    expect(found).toHaveLength(2)
    for (const message of found) {
      const read = messageFromMailbox(
        bytes.subarray(message.start, message.end)
      )
      expect(message.size).toBe(read.byteLength)
      expect(message.detected?.kind).toBe("eml")
    }
  })

  it("refuses too many messages as soon as it has counted them", () => {
    const limits = { ...mboxLimits(), maxMessages: 3 }
    const scanner = new MailboxScanner(limits, () => {})
    const bytes = Buffer.from(mailboxOf(8), "latin1")

    expect(() => {
      for (let at = 0; at < bytes.byteLength; at += 64) {
        scanner.write(bytes.subarray(at, at + 64))
      }
      scanner.end()
    }).toThrow(MboxLimitError)
  })

  it("refuses too many bytes only once it has seen them all", () => {
    const limits = { ...mboxLimits(), maxTotalBytes: 100 }
    const reported: number[] = []
    const scanner = new MailboxScanner(limits, (message) =>
      reported.push(message.index)
    )
    scanner.write(Buffer.from(mailboxOf(3), "latin1"))

    expect(() => scanner.end()).toThrow(MboxLimitError)
    // Every message was located before the verdict, and the caller builds
    // nothing from a scan that throws.
    expect(reported).toEqual([0, 1, 2])
  })
})
