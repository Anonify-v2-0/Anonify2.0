import { describe, expect, it } from "vitest"

import {
  detectDocumentType,
  extensionMatchesKind,
} from "@/lib/documents/detect"
import { planAttachment, planExpansion } from "@/lib/documents/eml/attachments"
import { decodeEml, encodeEml } from "@/lib/documents/eml/parse"
import { formatOf, isPureContainer } from "@/lib/documents/formats"
import { maxBatchFiles } from "@/lib/documents/batch-config"
import {
  mboxDefaultsFor,
  mboxEnvName,
  mboxLimits,
  MboxLimitError,
} from "@/lib/documents/mbox/limits"
import {
  messageName,
  messagePartPath,
  planMailbox,
  planMessage,
} from "@/lib/documents/mbox/messages"
import {
  looksLikeMbox,
  MboxParseError,
  splitMailbox,
  unquoteFromLines,
  type MailboxEntry,
} from "@/lib/documents/mbox/parse"
import {
  mailboxCoverage,
  messageIsUnwrapped,
  messagesReparse,
} from "@/lib/documents/mbox/validate"

import { bytesOf, EML, simpleEml } from "./eml-fixtures"
import { makeDocxFixture, makePdfFixture } from "./fixtures"
import {
  attachmentOnlyMessage,
  bodylessMessage,
  forwardedMailboxMessage,
  fromLine,
  mailbox,
  mailboxOf,
  numberedMessage,
  quotingHazardMessage,
} from "./mbox-fixtures"

/**
 * A mailbox, tested as what it is: a container somebody exported from a mail
 * client, holding bytes from strangers, that turns one upload into hundreds of
 * documents.
 *
 * The failure mode this suite is really about is arithmetic rather than
 * textual. Every other format's suite asks "is the value gone?"; here the
 * question is "are they all here?", and nobody counts to nine hundred. A
 * splitter that quietly drops the messages it does not recognise produces a
 * batch that looks entirely normal and is missing exactly the unusual ones —
 * which are the ones worth reviewing. So most of what follows is about
 * conservation: the same number out as in, every byte accounted for, and every
 * message still a message.
 *
 * The database side — children, charges, retries, carried decisions — lives in
 * `tests/integration/mailbox.integration.test.ts`, because "charged exactly
 * once across a retry" is a property of a row and a fake would agree with
 * whatever the code did.
 */

const pdf = await makePdfFixture()
const docx = await makeDocxFixture()

function entriesOf(source: string): MailboxEntry[] {
  return splitMailbox(source)
}

describe("recognising a mailbox", () => {
  it("reads a `From ` line and the headers behind it", () => {
    expect(looksLikeMbox(bytesOf(mailboxOf(3)))).toBe(true)
  })

  it("sniffs one out of the bytes, ahead of the message it contains", () => {
    const detected = detectDocumentType(bytesOf(mailboxOf(2)), "archive.mbox")

    expect(detected?.kind).toBe("mbox")
    expect(detected?.mimeType).toBe(formatOf("mbox").mimeType)
    expect(extensionMatchesKind("archive.mbox", "mbox")).toBe(true)
  })

  it("still reads a single message as a message", () => {
    // The two tests overlap by construction — a mailbox is messages — so the
    // order they are asked in is the whole of what keeps them apart.
    expect(looksLikeMbox(bytesOf(simpleEml()))).toBe(false)
    expect(detectDocumentType(bytesOf(simpleEml()))?.kind).toBe("eml")
  })

  it("is not fooled by prose that begins with the word", () => {
    const prose = "From the top, the numbers are wrong.\r\nNobody checked.\r\n"
    expect(looksLikeMbox(bytesOf(prose))).toBe(false)
  })

  it("is not fooled by a separator with nothing behind it", () => {
    // The shape is right and the content is not a message. Without the header
    // check this would be a mailbox holding one document of arbitrary prose.
    const fake = `${fromLine()}\r\nJust some notes I typed.\r\nNothing else.\r\n`
    expect(looksLikeMbox(bytesOf(fake))).toBe(false)
  })

  it("is registered as a container that is never reviewed or exported", () => {
    const format = formatOf("mbox")

    expect(format.extractable).toBe(false)
    expect(format.exportable).toBe(false)
    expect(format.container).toBe("mime")
    expect(isPureContainer("mbox")).toBe(true)
    // Every other kind is a document somebody reviews.
    expect(isPureContainer("eml")).toBe(false)
  })
})

describe("splitting a mailbox", () => {
  it("finds every message, in order, and unwraps each one", () => {
    const source = mailboxOf(5)
    const entries = entriesOf(source)

    expect(entries).toHaveLength(5)
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4])

    for (const entry of entries) {
      expect(messageIsUnwrapped(entry)).toBe(true)
      expect(decodeEml(entry.bytes)).toContain("Subject: Message number")
    }
    expect(decodeEml(entries[0].bytes)).toContain("Message number 1")
    expect(decodeEml(entries[4].bytes)).toContain("Message number 5")
  })

  it("accounts for every byte of the file", async () => {
    const source = mailboxOf(4)
    const entries = entriesOf(source)

    const coverage = mailboxCoverage(source, entries)
    expect(coverage.orphaned).toBe(0)
    expect(coverage.passed).toBe(true)
    expect(coverage.covered + coverage.structural).toBe(source.length)

    expect(await messagesReparse(entries)).toBe(true)
  })

  it("keeps the message a message: no separator, no terminating blank line", () => {
    const [only] = entriesOf(mailboxOf(1))
    const source = decodeEml(only.bytes)

    expect(source.startsWith("From:")).toBe(true)
    // One trailing newline, not two: the blank line before a separator belongs
    // to the mailbox, and carrying it in would make every message out of here
    // differ from the same `.eml` off a desktop.
    expect(source.endsWith("\r\n")).toBe(true)
    expect(source.endsWith("\r\n\r\n")).toBe(false)
  })

  it("reads a mailbox written with bare newlines", () => {
    // A mailbox that only works on CRLF works on roughly half of them.
    const entries = entriesOf(mailboxOf(3).replace(/\r\n/g, "\n"))
    expect(entries).toHaveLength(3)
    expect(entries.every(messageIsUnwrapped)).toBe(true)
  })

  it("refuses a file with no messages in it rather than inventing one", () => {
    expect(() => splitMailbox("Just some notes.\r\nNothing else.\r\n")).toThrow(
      MboxParseError
    )
  })
})

describe("the `From ` line in a body", () => {
  it("does not fracture a message on any of the ways it can appear", () => {
    const source = mailbox([
      numberedMessage(1),
      quotingHazardMessage(),
      numberedMessage(2),
    ])
    const entries = entriesOf(source)

    // Three messages, not six. The hazard message alone contains three lines
    // that a prefix test would have cut on.
    expect(entries).toHaveLength(3)
    expect(entries.every(messageIsUnwrapped)).toBe(true)

    const middle = decodeEml(entries[1].bytes)
    expect(middle).toContain("Subject: Where it came from")
    // The whole body arrived, including the line after the quoted separator —
    // which is what a fracture would have taken away.
    expect(middle).toContain("that is where the confusion started")
  })

  it("undoes the quoting a mailbox writer applied", () => {
    const [, hazard] = entriesOf(
      mailbox([numberedMessage(1), quotingHazardMessage()])
    )
    const body = decodeEml(hazard.bytes)

    expect(body).toContain("From the top, then: the numbers are wrong.")
    expect(body).not.toContain(">From the top, then")
    // One `>` removed from the run, not all of them.
    expect(body).toContain(">From the archive I pulled last week")
  })

  it("removes exactly one level of quoting, and only from a `From ` line", () => {
    expect(unquoteFromLines(">From here\r\n")).toBe("From here\r\n")
    expect(unquoteFromLines(">>>From here\r\n")).toBe(">>From here\r\n")
    expect(unquoteFromLines(">Fromage\r\n")).toBe(">Fromage\r\n")
    expect(unquoteFromLines("> From here\r\n")).toBe("> From here\r\n")
  })

  it("splits on a real separator even when a body quoted one earlier", () => {
    const source = mailbox([quotingHazardMessage(), numberedMessage(9)])
    const entries = entriesOf(source)

    expect(entries).toHaveLength(2)
    expect(decodeEml(entries[1].bytes)).toContain("Message number 9")
  })
})

describe("what a message in a mailbox is called", () => {
  it("names it by position, zero-padded, and never by its content", () => {
    const entries = entriesOf(mailboxOf(3))
    const names = entries.map((entry) =>
      messageName(entry.index, entries.length)
    )

    expect(names).toEqual([
      "message-0001.eml",
      "message-0002.eml",
      "message-0003.eml",
    ])
    // The subject is in the message and must not be in the filename: a name
    // ends up in an archive entry, in the export report and on a disk.
    expect(names.join(" ")).not.toContain("Message number")
  })

  it("pads wide enough for the mailbox it is in", () => {
    expect(messageName(0, 12_000)).toBe("message-00001.eml")
    expect(messageName(11_999, 12_000)).toBe("message-12000.eml")
  })

  it("keeps two messages apart when their Message-IDs are the same", () => {
    // Real archives carry duplicates — the same message filed twice, a thread
    // saved from two folders — and plenty of messages carry none at all.
    const source = mailbox([
      numberedMessage(1, { messageId: "<same@example.com>" }),
      numberedMessage(2, { messageId: "<same@example.com>" }),
      numberedMessage(3, { messageId: null }),
      numberedMessage(4, { messageId: null }),
    ])
    const entries = entriesOf(source)

    const paths = entries.map((entry) => messagePartPath(entry.index))
    expect(paths).toEqual(["msg-0", "msg-1", "msg-2", "msg-3"])
    expect(new Set(paths).size).toBe(4)
  })

  it("gives the same message the same path on a second split", () => {
    // The path is what makes a retry idempotent: it is half of the database's
    // uniqueness constraint, so it has to survive re-splitting from scratch.
    const source = mailboxOf(6)
    const first = entriesOf(source).map((entry) => messagePartPath(entry.index))
    const second = entriesOf(source).map((entry) =>
      messagePartPath(entry.index)
    )

    expect(second).toEqual(first)
  })
})

describe("messages that are not the ordinary case", () => {
  it("keeps a message with no body", () => {
    const entries = entriesOf(
      mailbox([numberedMessage(1), bodylessMessage(2), numberedMessage(3)])
    )

    expect(entries).toHaveLength(3)
    expect(decodeEml(entries[1].bytes)).toContain("Subject: Nothing to say 2")
    expect(planMessage(entries[1], 3).action).toBe("expand")
  })

  it("keeps a message that is nothing but its enclosures", () => {
    const source = mailbox([
      attachmentOnlyMessage([
        { contentType: "application/pdf", filename: "report.pdf", bytes: pdf },
      ]),
      numberedMessage(2),
    ])
    const entries = entriesOf(source)

    expect(entries).toHaveLength(2)
    // And it is still a message with an expandable attachment behind it, which
    // is what makes the mailbox a batch of more than its message count.
    const plan = planExpansion(decodeEml(entries[0].bytes))
    expect(plan.entries.map((entry) => entry.action)).toEqual(["expand"])
  })

  it("refuses an enclosure whose name lies about its bytes, by name", () => {
    // The reviewer keeps the rest of the mailbox: one stranger's wrong
    // filename must not cost them eight hundred other messages.
    const source = mailbox([
      attachmentOnlyMessage([
        {
          // The declared type is what a stranger chose; `application/octet-stream`
          // is what anything dragged out of an archive arrives as.
          contentType: "application/octet-stream",
          filename: "forward.eml",
          bytes: docx,
        },
      ]),
    ])
    const [only] = entriesOf(source)
    const [enclosure] = planExpansion(decodeEml(only.bytes)).entries

    expect(enclosure.action).toBe("refuse")
    if (enclosure.action !== "refuse") expect.unreachable()
    expect(enclosure.reason).toBe("extension-mismatch")
    expect(enclosure.kind).toBe("docx")
  })

  it("refuses bytes that are not a message, rather than processing them", () => {
    // Unreachable through the splitter, which will not open a message on bytes
    // that are not a header block. Asserted anyway, because "unreachable" is
    // not a property and this is the function that decides what gets processed.
    const notAMessage: MailboxEntry = {
      index: 0,
      fromLine: fromLine(),
      start: 0,
      end: docx.byteLength,
      bytes: docx,
    }
    const plan = planMessage(notAMessage, 1)

    expect(plan.action).toBe("refuse")
    if (plan.action !== "refuse") expect.unreachable()
    expect(plan.reason).toBe("unsupported-type")
  })
})

describe("the limits on a mailbox", () => {
  it("refuses a mailbox with more messages than it will expand", () => {
    const source = mailboxOf(12)

    expect(() =>
      splitMailbox(source, { ...mboxLimits(), maxMessages: 5 })
    ).toThrow(MboxLimitError)
    // Whole, with nothing built: a reviewer handed the first five of twelve
    // has a batch that looks complete and is not.
    try {
      splitMailbox(source, { ...mboxLimits(), maxMessages: 5 })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(MboxLimitError)
      expect((error as MboxLimitError).limit).toBe("maxMessages")
      expect((error as MboxLimitError).allowed).toBe(5)
    }
  })

  it("refuses a mailbox with more content behind it than it will read", () => {
    const source = mailboxOf(4)

    expect(() =>
      splitMailbox(source, { ...mboxLimits(), maxTotalBytes: 100 })
    ).toThrow(/maxTotalBytes/)
  })

  it("skips one oversized message and keeps the rest", () => {
    // A per-message ceiling is not a verdict on the mailbox. The big one is
    // present, named and explicitly not processed; the others are documents.
    const source = mailbox([
      numberedMessage(1),
      numberedMessage(2, { body: "x".repeat(4096) }),
      numberedMessage(3),
    ])
    const limits = { ...mboxLimits(), maxMessageBytes: 1024 }
    const plan = planMailbox(source, { limits })

    expect(plan.entries.map((entry) => entry.action)).toEqual([
      "expand",
      "refuse",
      "expand",
    ])
    const refused = plan.entries[1]
    if (refused.action !== "refuse") expect.unreachable()
    expect(refused.reason).toBe("too-large")
    // Named, so it is a row the reviewer sees rather than a gap they do not.
    expect(refused.name).toBe("message-0002.eml")
  })

  it("counts only what will be expanded towards the expanded bytes", () => {
    const plan = planMailbox(mailboxOf(3))
    const expanding = plan.entries.filter((entry) => entry.action === "expand")

    expect(plan.expandedBytes).toBe(
      expanding.reduce(
        (total, entry) => total + entry.entry.bytes.byteLength,
        0
      )
    )
  })

  it("refuses a mailbox that arrived inside a mailbox", () => {
    // The second recursion axis: a forwarded archive. The parser's nested
    // message limit bounds messages read inside one message; this bounds
    // documents created from one, which multiplies rather than adds.
    const inner = mailboxOf(3)
    const outer = mailbox([forwardedMailboxMessage(inner)])

    // Depth zero — somebody uploaded it — expands as normal.
    expect(planMailbox(outer, { depth: 0 }).entries).toHaveLength(1)

    // The inner one is reached at depth two, and stops there.
    expect(() => planMailbox(inner, { depth: 2 })).toThrow(MboxLimitError)
    try {
      planMailbox(inner, { depth: 2 })
      expect.unreachable()
    } catch (error) {
      expect((error as MboxLimitError).limit).toBe("maxDepth")
    }
  })

  it("recognises the forwarded mailbox as a mailbox, from its bytes", () => {
    const inner = mailboxOf(2)
    const [only] = entriesOf(mailbox([forwardedMailboxMessage(inner)]))
    const [enclosure] = planExpansion(decodeEml(only.bytes)).entries

    expect(enclosure.action).toBe("expand")
    if (enclosure.action !== "expand") expect.unreachable()
    expect(enclosure.kind).toBe("mbox")
  })

  it("does not refuse a mailbox at the depth limit that expands nothing", () => {
    // The limit is about work created, and a mailbox holding only messages we
    // could not read creates none.
    const unreadable = planMailbox(mailboxOf(2), {
      depth: 9,
      limits: { ...mboxLimits(), maxMessageBytes: 1 },
    })
    expect(unreadable.entries.every((entry) => entry.action === "refuse")).toBe(
      true
    )
  })
})

describe("configuring the limits", () => {
  it("rations a shared demo harder than somebody's own machine", () => {
    const demo = mboxDefaultsFor("demo")
    const own = mboxDefaultsFor("self-hosted")

    expect(demo.maxMessages).toBeLessThan(own.maxMessages)
    expect(demo.maxTotalBytes).toBeLessThan(own.maxTotalBytes)
    expect(demo.maxMessageBytes).toBeLessThan(own.maxMessageBytes)
  })

  it("never lets a mailbox produce a smaller batch than a person could assemble", () => {
    // The reconciliation with MAX_BATCH_FILES. The two are separate numbers
    // answering separate questions, and this is the direction that would
    // surprise somebody: dragging in fifty files works, a fifty-message
    // mailbox does not.
    const name = mboxEnvName("maxMessages")
    process.env[name] = "2"
    try {
      expect(mboxLimits().maxMessages).toBe(maxBatchFiles())
      expect(mboxLimits().maxMessages).toBeGreaterThanOrEqual(2)
    } finally {
      delete process.env[name]
    }
  })

  it("takes environment overrides, and reports a malformed one", () => {
    const name = mboxEnvName("maxTotalBytes")
    expect(name).toBe("ANONIFY_MBOX_MAX_TOTAL_BYTES")

    process.env[name] = "4096"
    try {
      expect(mboxLimits().maxTotalBytes).toBe(4096)
      process.env[name] = "plenty"
      expect(() => mboxLimits()).toThrow(/positive whole number/)
      process.env[name] = "0"
      expect(() => mboxLimits()).toThrow(/positive whole number/)
    } finally {
      delete process.env[name]
    }
  })

  it("names its refusals the way the other parsers name theirs", async () => {
    // `describeFailure` reads all three the same way, because to the person
    // holding the file they are one refusal with one remedy.
    const { describeFailure } = await import("@/lib/workflows/failure")

    expect(describeFailure(new MboxLimitError("maxMessages", 200)).code).toBe(
      "too-complex"
    )
    expect(
      describeFailure(new MboxParseError("No messages found in this mailbox"))
        .code
    ).toBe("empty-container")
  })
})

describe("what a mailbox costs", () => {
  it("charges a message what the same file would cost on its own", () => {
    // The mailbox is not a discount, for the same reason a batch is not one.
    // Every message is a child that will spend one upload and then its own
    // `emailKilobytes` when its extraction knows the real size.
    const plan = planMailbox(mailboxOf(7))

    expect(plan.entries).toHaveLength(7)
    expect(plan.entries.every((entry) => entry.kind === "eml")).toBe(true)
    expect(formatOf("eml").quota).toBe("emailKilobytes")
  })

  it("produces a child for every message, expanded or not", () => {
    // Never a silent drop. At this scale it matters more than anywhere else:
    // nobody scrolls a nine-hundred-row batch counting.
    const source = mailbox([
      numberedMessage(1),
      numberedMessage(2, { body: "x".repeat(4096) }),
      numberedMessage(3),
    ])
    const plan = planMailbox(source, {
      limits: { ...mboxLimits(), maxMessageBytes: 1024 },
    })

    expect(plan.entries).toHaveLength(3)
    expect(new Set(plan.entries.map((entry) => entry.name)).size).toBe(3)
  })
})

describe("the values inside are still findable", () => {
  it("hands each message on with its sensitive text intact", () => {
    // The container must not change what the detectors get to read. A splitter
    // that mangled a body would produce messages that review clean because the
    // value is no longer there to find.
    const entries = entriesOf(mailboxOf(3))

    for (const entry of entries) {
      const source = decodeEml(entry.bytes)
      expect(source).toContain(EML.person)
      expect(source).toContain(EML.email)
      expect(source).toContain(EML.phone)
    }
  })

  it("round-trips a message byte for byte through the container", () => {
    const original = numberedMessage(1)
    const [only] = entriesOf(mailbox([original]))

    expect(Buffer.from(only.bytes)).toEqual(Buffer.from(encodeEml(original)))
  })

  it("leaves an attachment inside a message exactly as it arrived", () => {
    const source = mailbox([
      attachmentOnlyMessage([
        { contentType: "application/pdf", filename: "report.pdf", bytes: pdf },
      ]),
    ])
    const [only] = entriesOf(source)
    const [enclosure] = planExpansion(decodeEml(only.bytes)).entries

    if (enclosure.action !== "expand") expect.unreachable()
    expect(Buffer.from(enclosure.attachment.bytes)).toEqual(Buffer.from(pdf))
    expect(planAttachment(enclosure.attachment).action).toBe("expand")
  })
})
