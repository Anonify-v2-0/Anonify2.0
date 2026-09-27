import { describe, expect, it } from "vitest"

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
import { collect } from "@/lib/storage/streams"
import { sha256 } from "@/lib/storage/integrity"

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
    open: async () =>
      (async function* () {
        for (let offset = 0; offset < bytes.byteLength; offset += size) {
          yield bytes.subarray(offset, offset + size)
        }
      })(),
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

  it("refuses a separator that would carry an accepted value", async () => {
    // Accepted in some message, and the one date the placeholder has to use.
    const error = await rejected(() =>
      buildVerifiedMailbox(
        children.map((bytes) => messageOf(bytes)),
        searchedValues(["2026", "1970"])
      )
    )
    expect(error.failure).toBe("separator-leak")
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
