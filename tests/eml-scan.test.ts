import { describe, expect, it } from "vitest"

import {
  attachmentsOfParsed,
  messageAttachments,
  planAttachments,
  planExpansion,
} from "@/lib/documents/eml/attachments"
import { emlDocument, extractEml } from "@/lib/documents/eml/extract"
import { DEFAULT_EML_LIMITS, type EmlLimits } from "@/lib/documents/eml/limits"
import { parseEml, type MimeNode, type ParsedMessage } from "@/lib/documents/eml/parse"
import { MimeScanner, scanEml } from "@/lib/documents/eml/scan"

import {
  alternativeEml,
  attachedEml,
  deeplyNestedEml,
  duplicatedEml,
  encodedHeaderEml,
  manyPartsEml,
  mixedEml,
  nestedEml,
  quotedReplyEml,
  richHtmlEml,
  simpleEml,
  truncatedMultipartEml,
  unreadableBytes,
} from "./eml-fixtures"
import { recursiveParseEml } from "./helpers/eml-parse-oracle"

/**
 * The forward MIME scanner, held to the recursive parser it replaced.
 *
 * The exporter edits a message by the byte offsets parsing produced, and the
 * address map resolves every reviewed span through them, so "close" is a leak
 * or a corrupted message. The contract is identity: the same tree, the same
 * offsets, the same decoded text, the same refusal — for every message, cut
 * into pieces at every size. The recursive parser is kept verbatim in
 * tests/helpers/eml-parse-oracle.ts to be held to.
 *
 * The messages are the fixtures, and then a few thousand generated ones built
 * to reach the corners: nested and reused boundaries, missing closing
 * delimiters, parts with no headers, headers with no end, LF and CRLF and lone
 * CR mixed, delimiters with trailing whitespace, empty parts back to back,
 * and random bytes cut out of and spliced into all of it.
 */

/** A seeded generator, so a failure names a message that can be replayed. */
function random(seed: number) {
  let state = seed >>> 0 || 1
  const next = () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
  return {
    next,
    int: (below: number) => Math.floor(next() * below),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  }
}

type Random = ReturnType<typeof random>

const BOUNDARIES = ["b1", "outer", "inner", "b1", "x--", "=_Part_1", "a b", "b1"]

function lines(rng: Random, words: number): string {
  const vocabulary = ["John", "Smith", "jane@example.com", "=3D", "--b1", "From: x", "", " ", "\t", "é", "=\r\n", "ok"]
  return Array.from({ length: words }, () => rng.pick(vocabulary)).join(rng.pick([" ", "\r\n", "\n"]))
}

function part(rng: Random, depth: number): string {
  const eol = rng.pick(["\r\n", "\n", "\r\n", "\r\n\n", "\n"])
  const kind = depth > 3 ? rng.pick(["text", "attachment"]) : rng.pick(["text", "text", "attachment", "multipart", "multipart", "message", "bare"])
  const headers: string[] = []
  if (rng.chance(0.1)) headers.push("")
  if (kind === "text") {
    headers.push(`Content-Type: text/${rng.pick(["plain", "html"])}; charset=${rng.pick(["utf-8", "iso-8859-1", "bogus"])}`)
    headers.push(`Content-Transfer-Encoding: ${rng.pick(["7bit", "base64", "quoted-printable", "8bit"])}`)
    if (rng.chance(0.2)) headers.push("Content-Disposition: attachment; filename=\"notes.txt\"")
  } else if (kind === "attachment") {
    headers.push(`Content-Type: application/octet-stream; name="f${rng.int(9)}.bin"`)
    headers.push("Content-Transfer-Encoding: base64")
  } else if (kind === "multipart") {
    const boundary = rng.pick(BOUNDARIES)
    headers.push(`Content-Type: multipart/${rng.pick(["mixed", "alternative"])}; boundary="${boundary}"`)
    const children = Array.from({ length: rng.int(4) }, () => part(rng, depth + 1))
    const body: string[] = []
    if (rng.chance(0.3)) body.push("preamble text")
    for (const child of children) {
      body.push(`--${boundary}${rng.chance(0.05) ? " " : ""}${rng.chance(0.05) ? "\r" : ""}`)
      body.push(child)
    }
    if (rng.chance(0.8)) body.push(`--${boundary}--`)
    if (rng.chance(0.3)) body.push("epilogue", `--${boundary}`)
    if (rng.chance(0.1)) headers.push("X-Folded: one", "  two")
    return [...headers, ...(rng.chance(0.9) ? [""] : []), body.join(eol)].join(eol)
  } else if (kind === "message") {
    headers.push("Content-Type: message/rfc822")
    return [...headers, "", `From: nested@example.com${eol}Subject: inner${eol}${part(rng, depth + 1)}`].join(eol)
  }
  if (rng.chance(0.1)) headers.push("Subject: =?utf-8?B?Sm9obiBTbWl0aA==?=")
  const blank = rng.chance(0.85) ? [""] : []
  const content =
    kind === "attachment"
      ? Buffer.from(lines(rng, rng.int(40))).toString("base64").replace(/(.{20})/g, `$1${eol}`)
      : lines(rng, rng.int(30))
  return [...headers, ...blank, content].join(eol)
}

function message(rng: Random): string {
  const eol = rng.pick(["\r\n", "\n"])
  const head = [
    "From: John Smith <john@example.com>",
    "To: jane@example.com",
    "Subject: generated",
    "MIME-Version: 1.0",
  ]
  if (rng.chance(0.05)) head.unshift("")
  return `${head.join(eol)}${eol}${part(rng, 0)}${rng.chance(0.5) ? eol : ""}`
}

/** Bytes cut out and spliced in, where parsers disagree if they are going to. */
function mutate(rng: Random, source: string): string {
  let out = source
  for (let count = rng.int(4); count > 0; count--) {
    const at = rng.int(out.length + 1)
    const edit = rng.int(4)
    if (edit === 0) out = out.slice(0, at) + out.slice(at + 1 + rng.int(6))
    else if (edit === 1) out = out.slice(0, at) + rng.pick(["\r", "\n", "\r\n", "\n\n", "--", "--b1\r\n", "--outer--\n", "\r\n\r\n"]) + out.slice(at)
    else if (edit === 2) out = out.slice(0, at) + "\n" + out.slice(at)
    else out = out.slice(0, at)
  }
  return out
}

function describeNode(node: MimeNode) {
  const { children, nested, ...rest } = node
  return {
    ...rest,
    children: children.map((child) => child.path),
    nested: nested ? nested.path : null,
  }
}

function snapshot(run: () => ParsedMessage): unknown {
  try {
    const parsed = run()
    return {
      root: parsed.root.path,
      nodes: parsed.nodes.map(describeNode),
    }
  } catch (error) {
    return { threw: (error as Error).name, message: (error as Error).message }
  }
}

function scanned(source: string, sizes: number[], limits: EmlLimits): ParsedMessage {
  const scanner = new MimeScanner(limits)
  let at = 0
  let turn = 0
  while (at < source.length) {
    const size = Math.max(1, sizes[turn++ % sizes.length])
    scanner.write(source.slice(at, at + size))
    at += size
  }
  return scanner.end()
}

const TIGHT: EmlLimits = {
  maxDepth: 3,
  maxParts: 6,
  maxTextBytes: 200,
  maxHeaderBytes: 120,
  maxAttachments: 2,
  maxNestedMessages: 1,
}

const CUTS = [[1], [2], [3], [7], [64], [1 << 20], [1, 5, 2, 11, 3]]

function expectSame(source: string, limits: EmlLimits, cuts = CUTS) {
  const expected = snapshot(() => recursiveParseEml(source, limits))
  for (const sizes of cuts) {
    const actual = snapshot(() => scanned(source, sizes, limits))
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      // The whole message in the failure, so it can be replayed.
      expect({ source, sizes, actual }).toEqual({ source, sizes, actual: expected })
    }
  }
}

const FIXTURES = [
  simpleEml(),
  alternativeEml(),
  richHtmlEml(),
  mixedEml(),
  quotedReplyEml(),
  nestedEml(),
  encodedHeaderEml(),
  duplicatedEml(),
  truncatedMultipartEml(),
  deeplyNestedEml(8),
  manyPartsEml(30),
  attachedEml([
    { contentType: "application/pdf", filename: "a.pdf", bytes: new Uint8Array(3000).fill(7) },
    { contentType: "application/zip", filename: "b.zip", bytes: unreadableBytes() },
  ]),
]

describe("the forward MIME scanner", () => {
  it("parses every fixture exactly as the recursive parser did", () => {
    for (const source of FIXTURES) {
      expectSame(source, DEFAULT_EML_LIMITS)
      expectSame(source, TIGHT)
    }
  })

  it("parses generated messages exactly as the recursive parser did", () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const rng = random(seed)
      const source = message(rng)
      expectSame(source, DEFAULT_EML_LIMITS, [[1 << 20], [3], [1, 5, 2, 11, 3]])
      expectSame(source, TIGHT, [[1 << 20], [7]])
    }
  })

  it("parses mutated messages exactly as the recursive parser did", () => {
    for (let seed = 1; seed <= 1500; seed++) {
      const rng = random(seed * 7919)
      const source = mutate(rng, rng.chance(0.3) ? rng.pick(FIXTURES) : message(rng))
      expectSame(source, DEFAULT_EML_LIMITS, [[1 << 20], [2], [1, 5, 2, 11, 3]])
      expectSame(source, TIGHT, [[1 << 20], [5]])
    }
  })

  it("refuses what the recursive parser refused, in the same words", () => {
    for (const source of ["", "   \r\n\t ", "no headers here\r\n\r\nbody", "\r\n\r\nbody"]) {
      expectSame(source, DEFAULT_EML_LIMITS)
    }
    // Whitespace that breaks a limit is still an empty message.
    expectSame(" ".repeat(500), TIGHT)
    expectSame(`${" ".repeat(500)}x`, TIGHT)
  })

  it("is what parseEml is, so the exporter and the extractor cannot disagree", () => {
    for (const source of FIXTURES) {
      expect(snapshot(() => parseEml(source))).toEqual(
        snapshot(() => recursiveParseEml(source, DEFAULT_EML_LIMITS))
      )
    }
  })
})

describe("scanning a message as it streams", () => {
  it("never holds an attachment's body", () => {
    const big = new Uint8Array(4 << 20).map((_, index) => (index * 31) & 0xff)
    const source = attachedEml([{ contentType: "application/octet-stream", filename: "big.bin", bytes: big }])
    const scanner = new MimeScanner(DEFAULT_EML_LIMITS)
    let peak = 0
    const window = (scanner as unknown as { window: { text: string } }).window
    for (let at = 0; at < source.length; at += 4096) {
      scanner.write(source.slice(at, at + 4096))
      peak = Math.max(peak, window.text.length)
    }
    const parsed = scanner.end()

    expect(parsed.nodes.some((node) => node.attachment && node.filename === "big.bin")).toBe(true)
    expect(peak).toBeLessThan(64 * 1024)
  })

  it("reads bytes as Latin-1, one character per byte, whatever the cut", async () => {
    const source = Buffer.from(mixedEml(), "latin1")
    async function* pieces() {
      for (let at = 0; at < source.byteLength; at += 3) yield source.subarray(at, at + 3)
    }
    let seen = 0
    const parsed = await scanEml(pieces(), DEFAULT_EML_LIMITS, (piece) => {
      seen += piece.byteLength
    })
    expect(seen).toBe(source.byteLength)
    expect(parsed.nodes.map(describeNode)).toEqual(
      recursiveParseEml(mixedEml(), DEFAULT_EML_LIMITS).nodes.map(describeNode)
    )
  })
})

describe("the generated corpus", () => {
  it("reaches the corners it was built to reach", () => {
    const seen = { bodyPastEnd: 0, startPastEnd: 0, refused: 0, parsed: 0, attachments: 0, nested: 0, headerless: 0 }
    for (let seed = 1; seed <= 1500; seed++) {
      for (const source of [message(random(seed)), mutate(random(seed * 7919), message(random(seed * 7919)))]) {
        try {
          const { nodes } = recursiveParseEml(source, DEFAULT_EML_LIMITS)
          seen.parsed += 1
          for (const node of nodes) {
            if (node.bodyStart > node.end) seen.bodyPastEnd += 1
            if (node.start > node.end) seen.startPastEnd += 1
            if (node.attachment) seen.attachments += 1
            if (node.nested) seen.nested += 1
            if (node.headers.length === 0) seen.headerless += 1
          }
        } catch {
          seen.refused += 1
        }
      }
    }
    // Every quirk the scanner reproduces has to actually occur here, or the
    // comparison above proves nothing about it.
    for (const [corner, count] of Object.entries(seen)) {
      expect(count, corner).toBeGreaterThan(5)
    }
  })
})

describe("a message extracted and planned as it streams", () => {
  async function* bytesOf(source: string, size: number) {
    const bytes = Buffer.from(source, "latin1")
    for (let at = 0; at < bytes.byteLength; at += size) yield bytes.subarray(at, at + size)
  }

  const withAttachments = attachedEml([
    { contentType: "application/pdf", filename: "John Smith.pdf", bytes: new Uint8Array(9000).fill(37) },
    { contentType: "text/csv", filename: "list.csv", bytes: new Uint8Array(Buffer.from("name,email\r\nJohn Smith,john@example.com\r\n")) },
    { contentType: "image/png", filename: "sig.png", bytes: new Uint8Array(2000).fill(1), contentId: "sig@x" },
  ])

  it("makes the model the whole-message extraction makes", async () => {
    for (const source of [...FIXTURES, withAttachments]) {
      const parsed = await scanEml(bytesOf(source, 97), DEFAULT_EML_LIMITS)
      expect(emlDocument("d", parsed)).toEqual(
        extractEml("d", new Uint8Array(Buffer.from(source, "latin1"))).document
      )
    }
  })

  it("describes and plans the attachments the whole-message path does", async () => {
    for (const source of [...FIXTURES, withAttachments]) {
      const bytes = Buffer.from(source, "latin1")
      const parsed = await scanEml(bytesOf(source, 101), DEFAULT_EML_LIMITS)
      const reads: [number, number][] = []
      const attachments = await attachmentsOfParsed(parsed, async (start, end) => {
        reads.push([start, end])
        return bytes.subarray(start, end)
      })

      expect(attachments).toEqual(messageAttachments(source, DEFAULT_EML_LIMITS))
      expect(planAttachments(attachments)).toEqual(planExpansion(source))
      // One read per attachment, of that attachment, and nothing else.
      expect(reads.length).toBe(attachments.filter((a) => a.bodyStart < a.bodyEnd).length)
    }
  })
})
