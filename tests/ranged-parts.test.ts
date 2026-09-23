import { describe, expect, it } from "vitest"

import { detectDocumentType } from "@/lib/documents/detect"
import {
  attachmentBytes,
  decodeAttachment,
  messageAttachments,
} from "@/lib/documents/eml/attachments"
import { DETECTION_SAMPLE_BYTES } from "@/lib/documents/sample"

import { attachedEml, bytesOf, simpleEml } from "./eml-fixtures"
import {
  makeDocxFixture,
  makeImageFixture,
  makePdfFixture,
  makeXlsxFixture,
} from "./fixtures"
import { mailboxOf } from "./mbox-fixtures"

/**
 * Two contracts the streaming pipeline leans on.
 *
 * Content sniffing reads the head of a file and nothing else, which is what
 * lets ingest sniff an upload it never holds and a mailbox sniff a message it
 * has not read out. If a detector ever reads past the sample, those two paths
 * quietly start deciding from less than the whole-file path does — so the
 * contract is checked against real files of every kind.
 *
 * And an attachment is a byte range until it becomes a document: its size and
 * head are learned once, and its bytes are decoded again from the range when
 * they are needed. Those bytes must be the ones the part actually carries,
 * whichever way the part was encoded.
 */

const pdf = await makePdfFixture()
const docx = await makeDocxFixture()
const xlsx = await makeXlsxFixture()
const png = await makeImageFixture()

function padded(bytes: Uint8Array, extra: number): Uint8Array {
  const out = new Uint8Array(bytes.byteLength + extra)
  out.set(bytes)
  out.fill(0x20, bytes.byteLength)
  return out
}

describe("the detection sample", () => {
  const files: [string, Uint8Array, string | undefined][] = [
    ["pdf", pdf, undefined],
    ["docx", docx, "report.docx"],
    ["xlsx", xlsx, "sheet.xlsx"],
    ["png", png, undefined],
    ["eml", bytesOf(simpleEml()), undefined],
    ["mbox", bytesOf(mailboxOf(40)), undefined],
    ["csv", new TextEncoder().encode("a,b\n".repeat(40_000)), "big.csv"],
    ["txt", new TextEncoder().encode("line\n".repeat(40_000)), "big.txt"],
  ]

  it("decides every kind from the head alone", () => {
    for (const [, bytes, name] of files) {
      const whole = detectDocumentType(bytes, name)
      const head = detectDocumentType(
        bytes.subarray(0, DETECTION_SAMPLE_BYTES),
        name
      )
      expect(head).toEqual(whole)
      expect(whole).not.toBeNull()
    }
  })

  it("ignores what lies past the head, whatever it is", () => {
    // A control byte past the sample does not make a text file binary: the
    // whole-file sniff never looked there either.
    const text = new TextEncoder().encode("x".repeat(DETECTION_SAMPLE_BYTES))
    const tail = padded(text, 10)
    tail[tail.byteLength - 1] = 0x01
    expect(detectDocumentType(tail, "notes.txt")?.kind).toBe("txt")
  })
})

describe("attachments as ranges", () => {
  const encodings = ["base64", "quoted-printable", "7bit"] as const

  it("learns each part's size and head without keeping its bytes", () => {
    const big = padded(pdf, 3 * DETECTION_SAMPLE_BYTES)
    const source = attachedEml([
      { bytes: big, filename: "big.pdf", contentType: "application/pdf" },
    ])
    const [only] = messageAttachments(source)

    expect(only.size).toBe(big.byteLength)
    expect(only.head.byteLength).toBe(DETECTION_SAMPLE_BYTES)
    expect(
      Buffer.from(only.head).equals(
        Buffer.from(big.subarray(0, DETECTION_SAMPLE_BYTES))
      )
    ).toBe(true)
    expect(only).not.toHaveProperty("bytes")
  })

  /** One attachment, written in the transfer encoding under test. */
  function messageWith(encoding: (typeof encodings)[number]): string {
    const body =
      encoding === "base64"
        ? (
            Buffer.from(pdf)
              .toString("base64")
              .match(/.{1,76}/g) ?? []
          ).join("\r\n")
        : encoding === "quoted-printable"
          ? "Name=3A John Smith=\r\n, caf=C3=A9 owner\r\nPhone: 555-0100"
          : "Name: John Smith\r\nPhone: 555-0100"
    return [
      "From: a@example.com",
      "Subject: parts",
      "MIME-Version: 1.0",
      'Content-Type: multipart/mixed; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain",
      "",
      "Covering note.",
      "--b",
      "Content-Type: application/octet-stream",
      'Content-Disposition: attachment; filename="part.bin"',
      `Content-Transfer-Encoding: ${encoding}`,
      "",
      body,
      "--b--",
      "",
    ].join("\r\n")
  }

  it("decodes a part from its range exactly as from the whole message", () => {
    for (const encoding of encodings) {
      const source = messageWith(encoding)
      const [only] = messageAttachments(source)
      expect(only.encoding).toBe(encoding)
      const message = Buffer.from(source, "latin1")

      const fromRange = decodeAttachment(
        message.subarray(only.bodyStart, only.bodyEnd),
        only.encoding
      )
      expect(
        Buffer.from(fromRange).equals(
          Buffer.from(attachmentBytes(source, only))
        )
      ).toBe(true)
      expect(fromRange.byteLength).toBe(only.size)
    }
  })
})
