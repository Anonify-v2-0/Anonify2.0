import { Readable } from "node:stream"

import { describe, expect, it, vi } from "vitest"

import { splitMailbox } from "@/lib/documents/mbox/parse"
import {
  asctime,
  assertRebuilt,
  buildVerifiedMailbox,
  FromQuoter,
  MailboxReader,
  MailboxRebuildError,
  messageDate,
  PLACEHOLDER_SEPARATOR,
  searchedValues,
  separatorFor,
  streamRebuiltMailbox,
  writeMailbox,
  type RebuildMessage,
} from "@/lib/documents/mbox/rebuild"
import { chain, collect } from "@/lib/storage/streams"
import { ChecksumVerifier, sha256 } from "@/lib/storage/integrity"

import { EML } from "./eml-fixtures"
import {
  bodylessMessage,
  mailbox,
  numberedMessage,
  quotingHazardMessage,
} from "./mbox-fixtures"

/**
 * Putting a mailbox back together, read back by the splitter an upload uses.
 *
 * These are unit tests of the writer and the verifier with no database and no
 * redaction — the messages stand in for verified exports. What they prove is
 * the part that is new: that a mailbox rebuilt here splits into exactly the
 * messages that went in, byte for byte, with every body line that looked like
 * a separator still in its body, and that nothing about the source's own
 * separator lines survives into it. The round trip through a real redaction
 * is `tests/integration/batch-download.integration.test.ts`.
 */

/** Bytes as a message stream, cut into pieces of `size` to cross boundaries. */
function messageOf(bytes: Uint8Array, size = 7): RebuildMessage {
  return {
    checksum: sha256(bytes),
    open: async () => Readable.from(piecesOf(bytes, size)),
  }
}

function* piecesOf(bytes: Uint8Array, size: number): Generator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size)
  }
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1")
}

async function written(
  messages: RebuildMessage[],
  values: string[] = []
): Promise<string> {
  return latin1(await collect(writeMailbox(messages, { values })))
}

/** The messages of a source mailbox, as the children expansion made. */
function childrenOf(source: string): Uint8Array[] {
  return splitMailbox(source).map((entry) => entry.bytes)
}

describe("quoting From lines, a piece at a time", () => {
  async function quoted(text: string, size: number): Promise<string> {
    const quoter = new FromQuoter()
    const bytes = Buffer.from(text, "latin1")
    const out: Buffer[] = []
    for (let offset = 0; offset < bytes.length; offset += size) {
      out.push(...quoter.push(bytes.subarray(offset, offset + size)))
    }
    out.push(...quoter.end())
    return Buffer.concat(out).toString("latin1")
  }

  const text = [
    "From the top",
    ">From quoted once",
    ">>From quoted twice",
    "Not From at the start",
    "Fro",
    ">",
    "From",
    "",
  ].join("\n")

  const expected = [
    ">From the top",
    ">>From quoted once",
    ">>>From quoted twice",
    "Not From at the start",
    "Fro",
    ">",
    "From",
    "",
  ].join("\n")

  it("adds one > to every line matching ^>*From , and nothing else", async () => {
    expect(await quoted(text, text.length)).toBe(expected)
  })

  it("gives the same answer however the bytes are cut", async () => {
    for (const size of [1, 2, 3, 5, 8, 13]) {
      expect(await quoted(text, size)).toBe(expected)
    }
  })
})

describe("the separator line", () => {
  it("takes the date from the redacted message, and never a sender", () => {
    const head = Buffer.from(numberedMessage(1), "latin1")
    // The fixture's header says Monday; 3 March 2026 is a Tuesday, and the
    // line is written from the instant rather than copied from the text.
    expect(separatorFor(head, [])).toBe(
      "From MAILER-DAEMON Tue Mar  3 09:14:02 2026"
    )
  })

  it("falls back to the placeholder when there is no usable date", () => {
    const head = Buffer.from(
      "From: a@example.com\r\nDate: [REDACTED]\r\nSubject: x\r\n\r\nbody\r\n",
      "latin1"
    )
    expect(messageDate(head)).toBeNull()
    expect(separatorFor(head, [])).toBe(PLACEHOLDER_SEPARATOR)
  })

  it("reads only the header block, not a date in the body", () => {
    const head = Buffer.from(
      "From: a@example.com\r\nSubject: x\r\n\r\nDate: Mon, 3 Mar 2026 09:14:02 +0000\r\n",
      "latin1"
    )
    expect(messageDate(head)).toBeNull()
  })

  it("falls back when the date would put an accepted value on the line", () => {
    const head = Buffer.from(numberedMessage(1), "latin1")
    expect(separatorFor(head, searchedValues(["2026"]))).toBe(
      PLACEHOLDER_SEPARATOR
    )
  })

  it("does not count a value found only in the text it always writes", () => {
    // `1970` and `00:00` are the placeholder's; `Mailer-Daemon` is every
    // line's sender, and a bounce's display name that accepting every name
    // sweeps up. None of them says anything about a message.
    const head = Buffer.from(numberedMessage(1), "latin1")
    expect(separatorFor(head, searchedValues(["Mailer-Daemon"]))).toBe(
      "From MAILER-DAEMON Tue Mar  3 09:14:02 2026"
    )
    expect(
      separatorFor(head, searchedValues(["Mailer-Daemon", "2026", "1970"]))
    ).toBe(PLACEHOLDER_SEPARATOR)
  })

  it("still counts a value that reaches into a message's own date", () => {
    const head = Buffer.from(numberedMessage(1), "latin1")
    // Starts in the constant sender and ends in the date the message gave.
    expect(separatorFor(head, searchedValues(["daemon tue"]))).toBe(
      PLACEHOLDER_SEPARATOR
    )
  })

  it("writes asctime the way every mailbox reader parses it", () => {
    expect(asctime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      "Fri Jan  2 03:04:05 2026"
    )
  })
})

describe("rebuilding a mailbox", () => {
  const source = mailbox(
    [numberedMessage(1), quotingHazardMessage(), bodylessMessage(3)],
    // The envelope senders the source carried. None of them may come back.
    { senders: ["dickens@example.com", "MAILER-DAEMON", "-"] }
  )

  it("splits back into exactly the messages that went in, byte for byte", async () => {
    const children = childrenOf(source)
    const rebuilt = await written(children.map((bytes) => messageOf(bytes)))

    const reread = splitMailbox(rebuilt)
    expect(reread).toHaveLength(children.length)
    for (const [index, entry] of reread.entries()) {
      expect(
        Buffer.from(entry.bytes).equals(Buffer.from(children[index]))
      ).toBe(true)
    }
  })

  it("keeps a body line that looks like a separator inside its message", async () => {
    const children = childrenOf(source)
    const rebuilt = await written(children.map((bytes) => messageOf(bytes, 3)))

    // The child holds these unquoted — expansion undid the source's quoting —
    // and they are quoted again on the way out, so the splitter never sees a
    // seam in the body.
    expect(rebuilt).toContain("\r\n>From the top, then")
    expect(rebuilt).toContain("\r\n>From what I can tell")
    expect(rebuilt).toContain("\r\n>>From the archive")
    expect(latin1(splitMailbox(rebuilt)[1].bytes)).toContain(
      "From what I can tell nobody checked them."
    )
  })

  it("never copies the source's separator lines", async () => {
    const rebuilt = await written(
      childrenOf(source).map((bytes) => messageOf(bytes))
    )
    const separators = splitMailbox(rebuilt).map((entry) => entry.fromLine)

    expect(separators).toHaveLength(3)
    for (const line of separators) {
      expect(line.startsWith("From MAILER-DAEMON ")).toBe(true)
      expect(line).not.toContain("dickens@example.com")
      expect(line).not.toContain("From - ")
    }
    // The source's own dates are Fri Jan 2 and 3; the rebuilt ones are the
    // messages' Date headers, which is what the reviewer saw.
    expect(separators.join("\n")).not.toContain("Fri Jan")
  })

  it("ends a message that had no final line ending with one", async () => {
    const bare = Buffer.from(
      "From: a@example.com\nSubject: x\n\nno newline at the end",
      "latin1"
    )
    const rebuilt = await written([messageOf(bare), messageOf(bare)])
    const reread = splitMailbox(rebuilt)

    expect(reread).toHaveLength(2)
    expect(latin1(reread[0].bytes)).toBe(`${latin1(bare)}\n`)
  })

  it("is not withheld for a value that is only in its own constant text", async () => {
    // One message with no date of its own, so its line is the placeholder.
    const undated = Buffer.from(
      "From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n",
      "latin1"
    )
    const messages = [...childrenOf(source), undated].map((bytes) =>
      messageOf(bytes)
    )
    expect(splitMailbox(await written(messages))[3].fromLine).toBe(
      PLACEHOLDER_SEPARATOR
    )

    for (const values of [["1970"], ["Mailer-Daemon"], ["00:00:00 1970"]]) {
      // Accepted somewhere in the batch, and a coincidence on these lines: the
      // placeholder and the sender are constants this code chose.
      const verified = await buildVerifiedMailbox(
        messages,
        searchedValues(values)
      )
      expect(verified.messages).toBe(4)
    }
  })

  it("verifies what it built and delivers the same bytes", async () => {
    const children = childrenOf(source)
    const messages = children.map((bytes) => messageOf(bytes, 11))

    const verified = await buildVerifiedMailbox(messages, [])
    expect(verified.messages).toBe(3)

    const delivered = await collect(
      streamRebuiltMailbox(messages, [], verified)
    )
    expect(delivered.byteLength).toBe(verified.size)
    expect(sha256(delivered)).toBe(verified.checksum)
  })
})

describe("refusing a mailbox that does not verify", () => {
  const children = childrenOf(mailbox([numberedMessage(1), numberedMessage(2)]))

  async function rejected(
    run: () => Promise<unknown>
  ): Promise<MailboxRebuildError> {
    try {
      await run()
    } catch (error) {
      expect(error).toBeInstanceOf(MailboxRebuildError)
      return error as MailboxRebuildError
    }
    throw new Error("expected the mailbox to be refused")
  }

  it("refuses a message whose bytes are not the export that passed", async () => {
    const messages = children.map((bytes) => messageOf(bytes))
    messages[1] = { ...messages[1], checksum: sha256("something else") }

    const error = await rejected(() => buildVerifiedMailbox(messages, []))
    expect(error.failure).toBe("artifact-mismatch")
    expect(error.index).toBe(1)
  })

  it("falls back to the placeholder rather than carry a value in a date", async () => {
    const messages = children.map((bytes) => messageOf(bytes))
    const values = searchedValues(["2026", "1970"])

    // 2026 is in every message's date, so every line is the placeholder —
    // whose 1970 is its own, not a message's — and the mailbox verifies.
    await buildVerifiedMailbox(messages, values)
    const lines = splitMailbox(await written(messages, values)).map(
      (entry) => entry.fromLine
    )
    expect(lines).toEqual([PLACEHOLDER_SEPARATOR, PLACEHOLDER_SEPARATOR])
  })

  it("refuses a separator whose date carries an accepted value", async () => {
    const framed = children.map((bytes) => ({ checksum: sha256(bytes) }))
    const reader = new MailboxReader()
    // Written without the value, so the lines keep the messages' 2026 dates,
    // and then held to it: what the verifier would see had the fallback not
    // happened.
    reader.write(
      Buffer.from(
        await written(children.map((bytes) => messageOf(bytes))),
        "latin1"
      )
    )

    expect(() =>
      assertRebuilt(reader.end(), framed, searchedValues(["2026"]))
    ).toThrow(expect.objectContaining({ failure: "separator-leak", index: 0 }))
  })

  it("does not excuse a value merely because the sender is in it", async () => {
    const framed = children.map((bytes) => ({ checksum: sha256(bytes) }))
    const reader = new MailboxReader()
    reader.write(
      Buffer.from(
        await written(children.map((bytes) => messageOf(bytes))),
        "latin1"
      )
    )

    // Begins in the constant sender, ends in a message's date.
    expect(() =>
      assertRebuilt(reader.end(), framed, searchedValues(["daemon tue"]))
    ).toThrow(expect.objectContaining({ failure: "separator-leak" }))
  })

  it("refuses a message that the splitter reads back differently", async () => {
    const framed = children.map((bytes) => ({ checksum: sha256(bytes) }))
    const reader = new MailboxReader()
    // Tampered after it was written: one message's body changed in transit.
    const text = (
      await written(children.map((bytes) => messageOf(bytes)))
    ).replace("Message number 2", "Message number 9")
    reader.write(Buffer.from(text, "latin1"))

    expect(() => assertRebuilt(reader.end(), framed, [])).toThrow(
      expect.objectContaining({ failure: "message-mismatch", index: 1 })
    )
  })

  it("refuses a mailbox that splits into a different number of messages", async () => {
    const framed = children.map((bytes) => ({ checksum: sha256(bytes) }))
    const reader = new MailboxReader()
    // The separator between the two messages lost its blank line, so the
    // splitter reads one message where two were written.
    const text = (
      await written(children.map((bytes) => messageOf(bytes)))
    ).replace("\r\n\r\nFrom MAILER-DAEMON", "\r\nFrom MAILER-DAEMON")
    reader.write(Buffer.from(text, "latin1"))

    expect(() => assertRebuilt(reader.end(), framed, [])).toThrow(
      expect.objectContaining({ failure: "count-mismatch" })
    )
  })

  it("refuses a separator this code did not write", async () => {
    const framed = children.map((bytes) => ({ checksum: sha256(bytes) }))
    const reader = new MailboxReader()
    const text = (
      await written(children.map((bytes) => messageOf(bytes)))
    ).replaceAll("From MAILER-DAEMON", `From ${EML.email}`)
    reader.write(Buffer.from(text, "latin1"))

    expect(() => assertRebuilt(reader.end(), framed, [])).toThrow(
      expect.objectContaining({ failure: "separator-leak" })
    )
  })

  it("refuses an empty mailbox rather than delivering one", async () => {
    const error = await rejected(() => buildVerifiedMailbox([], []))
    expect(error.failure).toBe("count-mismatch")
  })
})

describe("letting go of a download nobody finishes", () => {
  /**
   * A message longer than the head read before its separator, so that there
   * is a `rest` to be suspended inside, and longer than every buffer between
   * the writer and a reader put together, so that a reader who stops early
   * stops partway through it.
   */
  const long = Buffer.from(
    "From: a@example.com\nDate: Mon, 5 Jan 2026 10:00:00 +0000\n\n" +
      "A line of body text that goes on for a while.\n".repeat(20_000),
    "latin1"
  )

  /**
   * Opened the way the batch download opens an export: a storage stream,
   * chained into the verifier that holds it to its checksum. Both are kept,
   * because the storage stream is the one that holds the socket.
   */
  function stored(
    bytes: Uint8Array,
    opened: Readable[],
    onMismatch?: () => void
  ): RebuildMessage {
    const checksum = sha256(bytes)
    return {
      checksum,
      open: async () => {
        const storage = Readable.from(piecesOf(bytes, 1024))
        const verified = chain(
          storage,
          new ChecksumVerifier(checksum, onMismatch)
        )
        opened.push(storage, verified)
        return verified
      },
    }
  }

  function allDestroyed(opened: Readable[]): void {
    expect(opened.length).toBeGreaterThan(0)
    for (const stream of opened) expect(stream.destroyed).toBe(true)
  }

  it("closes the message it stopped on, before its body was started", async () => {
    const opened: Readable[] = []
    const writer = writeMailbox([stored(long, opened), stored(long, opened)], {
      values: [],
    })

    const separator = await writer.next()
    expect(latin1(separator.value as Buffer)).toMatch(/^From MAILER-DAEMON /)
    await writer.return(undefined)

    // The second message was never opened, and the first is closed.
    expect(opened).toHaveLength(2)
    await vi.waitFor(() => allDestroyed(opened))
  })

  it("closes the message it stopped on, partway through its body", async () => {
    const opened: Readable[] = []
    const writer = writeMailbox([stored(long, opened), stored(long, opened)], {
      values: [],
    })

    // Past the head, so the writer is inside the rest of the message.
    let out = 0
    while (out < long.byteLength / 2) {
      const next = await writer.next()
      out += (next.value as Buffer).byteLength
    }
    await writer.throw(new Error("the reader went away")).catch(() => {})

    expect(opened).toHaveLength(2)
    await vi.waitFor(() => allDestroyed(opened))
  })

  it("closes every stream behind a delivery that is destroyed", async () => {
    const opened: Readable[] = []
    const onMismatch = vi.fn()
    const messages = [long, long, long].map((bytes) =>
      stored(bytes, opened, onMismatch)
    )
    const verified = await buildVerifiedMailbox(messages, [])
    // The verification pass read every message to its end.
    expect(opened).toHaveLength(6)
    allDestroyed(opened)
    opened.length = 0

    const delivery = streamRebuiltMailbox(messages, [], verified, onMismatch)
    for await (const piece of delivery) {
      expect(piece.byteLength).toBeGreaterThan(0)
      break
    }

    await vi.waitFor(() => allDestroyed(opened))
    // Abandoned is not tampered with: nothing is reported as a mismatch.
    expect(onMismatch).not.toHaveBeenCalled()
  })

  it("closes nothing early for a delivery that is read to its end", async () => {
    const opened: Readable[] = []
    const onMismatch = vi.fn()
    const messages = [long, long].map((bytes) =>
      stored(bytes, opened, onMismatch)
    )
    const verified = await buildVerifiedMailbox(messages, [])

    const delivered = await collect(
      streamRebuiltMailbox(messages, [], verified, onMismatch)
    )

    expect(sha256(delivered)).toBe(verified.checksum)
    expect(splitMailbox(latin1(delivered))).toHaveLength(2)
    expect(onMismatch).not.toHaveBeenCalled()
    allDestroyed(opened)
  })
})
