import { describe, expect, it } from "vitest"

import { buildBatchReport } from "@/lib/redaction/archive"
import {
  artifactPath,
  comparePartPaths,
  mailboxLabelWidth,
  mailboxVaultPath,
  originalEntries,
  processedPlacements,
  provenancePath,
  provenanceTree,
  reportPath,
  vaultPath,
  walk,
  type LayoutDocument,
} from "@/lib/redaction/batch-layout"
import type { ExportReport } from "@/lib/redaction/report"
import type { DocumentKind } from "@/types/document"

/**
 * The shape a batch goes back out in.
 *
 * Pure functions of two columns — the parent a document came out of and where
 * in it — so these tests need no database and no storage. What they hold the
 * layout to is the part of the issue that is about trust rather than
 * convenience: nothing under a top-level upload is named after anything a
 * document chose, and a mailbox is rebuilt in the order it was written.
 */

function doc(
  id: string,
  kind: DocumentKind,
  originalName: string,
  parent: string | null = null,
  part: string | null = null
): LayoutDocument {
  return {
    id,
    kind,
    originalName,
    parentDocumentId: parent,
    sourcePartPath: part,
  }
}

/**
 * A batch as it lands in the database: a mailbox of three messages, the
 * second carrying two attachments — one of them a forwarded message with an
 * enclosure of its own — a message uploaded with an attachment, and a PDF.
 *
 * Rows arrive in creation order, which is not tree order: children are made
 * after their parent, and attachments after every message.
 */
const BATCH: LayoutDocument[] = [
  doc("mbx", "mbox", "inbox.mbox"),
  doc("letter", "eml", "letter to Dr Jane Doe.eml"),
  doc("pdf", "pdf", "contract.pdf"),
  doc("m2", "eml", "message-0003.eml", "mbx", "msg-2"),
  doc("m0", "eml", "message-0001.eml", "mbx", "msg-0"),
  doc("m1", "eml", "message-0002.eml", "mbx", "msg-1"),
  doc("a10", "pdf", "Jane Doe payslip.pdf", "m1", "0.10"),
  doc("a2", "eml", "Fwd: salary.eml", "m1", "0.2"),
  doc("a2x", "docx", "Jane Doe CV.docx", "a2", "0.2"),
  doc("la", "xlsx", "bank details for John.xlsx", "letter", "0.2"),
]

describe("the batch as the tree it arrived as", () => {
  const roots = provenanceTree(BATCH)

  it("keeps uploads in upload order and children in source order", () => {
    expect(roots.map((root) => root.document.id)).toEqual([
      "mbx",
      "letter",
      "pdf",
    ])
    expect(roots[0].children.map((child) => child.document.id)).toEqual([
      "m0",
      "m1",
      "m2",
    ])
    // Numerically, part by part: 0.2 before 0.10.
    const m1 = roots[0].children[1]
    expect(m1.children.map((child) => child.document.id)).toEqual(["a2", "a10"])
  })

  it("orders parts numerically, not as strings", () => {
    expect(["0.10", "0.2", "0.9", "0.1.3"].sort(comparePartPaths)).toEqual([
      "0.1.3",
      "0.2",
      "0.9",
      "0.10",
    ])
    expect(["msg-10", "msg-2", "msg-0"].sort(comparePartPaths)).toEqual([
      "msg-0",
      "msg-2",
      "msg-10",
    ])
  })

  it("names where a document came from by part paths alone", () => {
    const byId = new Map(walk(roots).map((node) => [node.document.id, node]))
    expect(provenancePath(byId.get("a2x")!)).toEqual(["msg-1", "0.2", "0.2"])
    expect(provenancePath(byId.get("pdf")!)).toEqual([])
  })

  it("stands a child whose parent is gone at the top rather than losing it", () => {
    const orphaned = provenanceTree([
      doc("m5", "eml", "message-0006.eml", "expired", "msg-5"),
    ])
    expect(orphaned.map((root) => root.document.id)).toEqual(["m5"])
  })
})

describe("the processed layout", () => {
  const roots = provenanceTree(BATCH)
  const placements = processedPlacements(roots)
  const files = walk(roots)
    .filter((node) => node.document.kind !== "mbox")
    .map((node) =>
      artifactPath(placements.get(node.document.id)!, node.document.kind)
    )

  it("mirrors where each document came from", () => {
    expect(files).toEqual([
      "inbox-redacted/0001/message-redacted.eml",
      "inbox-redacted/0002/message-redacted.eml",
      "inbox-redacted/0002/attachments/0.2/0.2-redacted.eml",
      "inbox-redacted/0002/attachments/0.2/attachments/0.2-redacted.docx",
      "inbox-redacted/0002/attachments/0.10-redacted.pdf",
      "inbox-redacted/0003/message-redacted.eml",
      "letter to Dr Jane Doe-redacted/letter to Dr Jane Doe-redacted.eml",
      "letter to Dr Jane Doe-redacted/attachments/0.2-redacted.xlsx",
      "contract-redacted.pdf",
    ])
  })

  it("never names anything under an upload after what a document chose", () => {
    // Every child's own filename carries a person's name, and none of them
    // survives. The top-level upload keeps its own name — the reviewer chose
    // it — and that is the only name anywhere in the tree.
    const beneath = files.map((path) =>
      path.replaceAll("letter to Dr Jane Doe", "LETTER")
    )
    for (const path of beneath) {
      expect(path).not.toMatch(/Jane|John|salary|payslip|CV|bank/)
    }
  })

  it("puts reports under reports/ and vaults beside their files", () => {
    const placement = placements.get("a10")!
    expect(reportPath(placement)).toBe(
      "reports/inbox-redacted/0002/attachments/0.10-redaction-report.json"
    )
    expect(vaultPath(placement)).toBe(
      "inbox-redacted/0002/attachments/0.10-vault.json"
    )
  })

  it("keeps two uploads of the same name apart", () => {
    const twins = processedPlacements(
      provenanceTree([
        doc("x", "mbox", "inbox.mbox"),
        doc("y", "mbox", "inbox.mbox"),
        doc("x0", "eml", "message-0001.eml", "x", "msg-0"),
        doc("y0", "eml", "message-0001.eml", "y", "msg-0"),
      ])
    )
    expect(twins.get("x0")!.dir).toBe("inbox-redacted/0001/")
    expect(twins.get("y0")!.dir).toBe("inbox-2-redacted/0001/")
  })

  it("widens the message number past 9999 rather than colliding", () => {
    const big = provenanceTree([
      doc("mbx", "mbox", "big.mbox"),
      doc("last", "eml", "message-10000.eml", "mbx", "msg-9999"),
      doc("first", "eml", "message-00001.eml", "mbx", "msg-0"),
    ])
    const placed = processedPlacements(big)
    expect(placed.get("first")!.dir).toBe("big-redacted/00001/")
    expect(placed.get("last")!.dir).toBe("big-redacted/10000/")
    expect(mailboxLabelWidth(big[0])).toBe(5)
  })
})

describe("the original format", () => {
  const entries = originalEntries(provenanceTree(BATCH))

  it("is one entry per upload, a mailbox with its messages in order", () => {
    expect(entries.map((entry) => [entry.kind, entry.stem])).toEqual([
      ["mailbox", "inbox"],
      ["file", "letter to Dr Jane Doe"],
      ["file", "contract"],
    ])
    const mailbox = entries[0]
    expect(
      mailbox.kind === "mailbox" && mailbox.messages.map((m) => m.document.id)
    ).toEqual(["m0", "m1", "m2"])
  })

  it("puts a message's vault beside the mailbox, numbered, never inside it", () => {
    const mailbox = entries[0]
    if (mailbox.kind !== "mailbox") throw new Error("expected a mailbox")
    expect(mailboxVaultPath(mailbox.stem, mailbox.messages[1], 4)).toBe(
      "inbox-vaults/0002-vault.json"
    )
  })
})

describe("the batch report says where each file went", () => {
  function reportFor(id: string): ExportReport {
    return {
      document: { id, sourceChecksum: `src-${id}` },
      artifact: { checksum: `art-${id}` },
      removed: { total: 1, byCategory: [], byStyle: {}, byMethod: {} },
      notRemoved: { rejected: { total: 0 }, undecided: { total: 0 } },
    } as unknown as ExportReport
  }

  const report = buildBatchReport({
    batchId: "bat_1",
    output: "original",
    reports: [reportFor("m0"), reportFor("m2")],
    skipped: [{ documentId: "m1", reason: "verification-failed" }],
    placements: new Map([
      ["m0", { documentId: "mbx", path: ["msg-0"] }],
      ["m2", { documentId: "mbx", path: ["msg-2"] }],
    ]),
    containers: [
      {
        documentId: "mbx",
        kind: "mbox",
        checksum: "abc",
        verified: true,
        messages: {
          total: 3,
          included: 2,
          leftOut: [
            { message: 2, documentId: "m1", reason: "verification-failed" },
          ],
        },
      },
    ],
  })

  it("names the container each file went into, by id and part path", () => {
    expect(report.output).toBe("original")
    expect(report.documents.map((entry) => entry.container)).toEqual([
      { documentId: "mbx", path: ["msg-0"] },
      { documentId: "mbx", path: ["msg-2"] },
    ])
  })

  it("names every message left out of a mailbox, and never silently", () => {
    expect(report.containers[0].messages).toEqual({
      total: 3,
      included: 2,
      leftOut: [
        { message: 2, documentId: "m1", reason: "verification-failed" },
      ],
    })
    expect(report.notes).toContain(
      "A mailbox was rebuilt with 2 of 3 messages. 1 left out: message 2 (failed its export verification and was withheld)."
    )
  })

  it("says a mailbox that failed its own verification was withheld", () => {
    const withheld = buildBatchReport({
      batchId: "bat_1",
      output: "original",
      reports: [],
      skipped: [{ documentId: "mbx", reason: "verification-failed" }],
      containers: [
        {
          documentId: "mbx",
          kind: "mbox",
          checksum: null,
          verified: false,
          messages: { total: 3, included: 3, leftOut: [] },
        },
      ],
    })
    expect(withheld.notes).toContain(
      "A mailbox was rebuilt from 3 of 3 messages and failed its verification, so it was withheld."
    )
  })
})
