import { describe, expect, it } from "vitest"

import {
  DEFAULT_EXPANSION_LIMITS,
  ExpansionLimitError,
  expansionEnvName,
  expansionLimits,
  messageAttachments,
  planAttachment,
  planExpansion,
} from "@/lib/documents/eml/attachments"
import { decodeEml, decodeTransfer, parseEml } from "@/lib/documents/eml/parse"
import {
  redactEml,
  type AttachmentAction,
  type EmlRedactionPlan,
} from "@/lib/documents/eml/redact"
import {
  emlReparses,
  verifyAttachmentSubstitutions,
} from "@/lib/documents/eml/validate"
import { artifactName } from "@/lib/redaction/archive"
import { sha256 } from "@/lib/storage/integrity"

import {
  attachedEml,
  bytesOf,
  EML,
  inlineImageEml,
  unreadableBytes,
  type AttachmentSpec,
} from "./eml-fixtures"
import { makeDocxFixture, makeImageFixture, makePdfFixture } from "./fixtures"

/**
 * The expansion path, tested as what it is: a thing that takes bytes from a
 * stranger and turns them into documents.
 *
 * Everything here is about the decision rather than the plumbing — which
 * attachment becomes a document, which is refused and named, which is carried
 * through, and what the exported message then actually carries. The database
 * side of it (children, charges, retries) lives in
 * `tests/integration/attachments.integration.test.ts`, because "charged
 * exactly once across a retry" is a property of a row and a fake would agree
 * with whatever the code did.
 */

const pdf = await makePdfFixture()
const docx = await makeDocxFixture()
const png = await makeImageFixture()

function attachment(
  overrides: Partial<AttachmentSpec> & Pick<AttachmentSpec, "bytes">
): AttachmentSpec {
  return {
    contentType: "application/pdf",
    filename: "report.pdf",
    ...overrides,
  }
}

function partsOf(source: string) {
  return messageAttachments(source)
}

function emptyPlan(overrides: Partial<EmlRedactionPlan> = {}): EmlRedactionPlan {
  return {
    bodies: {},
    headers: {},
    filenames: {},
    attachments: {},
    values: [],
    label: null,
    ...overrides,
  }
}

/** The decoded bytes of one part of an exported message. */
function partBytes(exported: Uint8Array, path: string): Uint8Array {
  const source = decodeEml(exported)
  const node = parseEml(source).nodes.find((candidate) => candidate.path === path)
  if (!node) throw new Error(`no part ${path}`)
  return new Uint8Array(
    decodeTransfer(source.slice(node.bodyStart, node.end), node.encoding)
  )
}

function headerOf(exported: Uint8Array, path: string, name: string): string {
  const node = parseEml(decodeEml(exported)).nodes.find(
    (candidate) => candidate.path === path
  )
  return node?.headers.find((header) => header.name === name)?.value ?? ""
}

describe("enumerating a message's attachments", () => {
  it("decodes each part's real bytes, not its declared type", () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const [only] = partsOf(source)

    expect(only.path).toBe("0.2")
    expect(only.filename).toBe("report.pdf")
    expect(Buffer.from(only.bytes)).toEqual(Buffer.from(pdf))
  })

  it("treats an inline cid: image as an attachment, and says it is inline", () => {
    const [only] = partsOf(inlineImageEml(png))

    expect(only.inline).toBe(true)
    expect(only.contentId).toBe("sig@example.com")
    expect(planAttachment(only).action).toBe("expand")
  })

  it("keeps two attachments with the same filename apart by part path", () => {
    const source = attachedEml([
      attachment({ bytes: pdf }),
      attachment({ bytes: pdf }),
    ])
    const parts = partsOf(source)

    expect(parts.map((part) => part.path)).toEqual(["0.2", "0.3"])
    expect(new Set(parts.map((part) => part.filename)).size).toBe(1)
  })

  it("reads an RFC 2231 split, charset-tagged filename", () => {
    const source = attachedEml([
      attachment({
        bytes: pdf,
        filename: null,
        rawParameters:
          "; filename*0*=utf-8''Rapport%20de%20Zo; filename*1*=%C3%A9%20M%C3%BCller.pdf",
      }),
    ])

    expect(partsOf(source)[0].filename).toBe("Rapport de Zoé Müller.pdf")
  })
})

describe("deciding what an attachment becomes", () => {
  it("expands a supported format, deciding the kind from the bytes", () => {
    const plan = planAttachment(partsOf(attachedEml([attachment({ bytes: pdf })]))[0])

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return
    expect(plan.kind).toBe("pdf")
    expect(plan.name).toBe("report.pdf")
  })

  it("ignores a lying content type and believes the bytes", () => {
    const plan = planAttachment(
      partsOf(
        attachedEml([
          attachment({
            bytes: png,
            contentType: "application/vnd.ms-excel",
            filename: "quarter.png",
          }),
        ])
      )[0]
    )

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return
    expect(plan.kind).toBe("image")
  })

  it("refuses a filename that lies about the contents, and names it", () => {
    const plan = planAttachment(
      partsOf(
        attachedEml([attachment({ bytes: docx, filename: "report.pdf" })])
      )[0]
    )

    expect(plan.action).toBe("refuse")
    if (plan.action !== "refuse") return
    expect(plan.reason).toBe("extension-mismatch")
    // Named, because a child nobody can see is a reviewer believing they have
    // seen everything.
    expect(plan.name).toBe("report.pdf")
    expect(plan.kind).toBe("docx")
  })

  it("refuses an attachment larger than the expansion limit", () => {
    const plan = planAttachment(
      partsOf(attachedEml([attachment({ bytes: pdf })]))[0],
      { ...DEFAULT_EXPANSION_LIMITS, maxAttachmentBytes: 10 }
    )

    expect(plan.action).toBe("refuse")
    if (plan.action !== "refuse") return
    expect(plan.reason).toBe("too-large")
  })

  it("carries through a format it cannot read", () => {
    const plan = planAttachment(
      partsOf(
        attachedEml([
          attachment({
            bytes: unreadableBytes(),
            contentType: "application/zip",
            filename: "bundle.zip",
          }),
        ])
      )[0]
    )

    expect(plan.action).toBe("carry")
  })

  it("carries through an empty part rather than inventing a document for it", () => {
    const plan = planAttachment(
      partsOf(
        attachedEml([attachment({ bytes: new Uint8Array(), filename: "nothing.pdf" })])
      )[0]
    )

    expect(plan.action).toBe("carry")
  })

  it("names an attachment that has no filename after its part path", () => {
    const plan = planAttachment(
      partsOf(attachedEml([attachment({ bytes: pdf, filename: null })]))[0]
    )

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return
    expect(plan.name).toBe("part-0_2.pdf")
  })

  it("names an attachment whose filename is entirely blank", () => {
    const plan = planAttachment(
      partsOf(attachedEml([attachment({ bytes: pdf, filename: "   " })]))[0]
    )

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return
    expect(plan.name).toBe("part-0_2.pdf")
  })

  it.each([
    "../../etc/passwd.pdf",
    "/etc/passwd.pdf",
    "C:\\Windows\\System32\\config.pdf",
    "....//....//passwd.pdf",
  ])("leaves %s to be sanitized where it reaches a zip", (filename) => {
    const plan = planAttachment(
      partsOf(attachedEml([attachment({ bytes: pdf, filename })]))[0]
    )

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return

    const entry = artifactName(plan.name, "pdf")
    expect(entry).not.toMatch(/[\\/]/)
    expect(entry.startsWith(".")).toBe(false)
    expect(entry.split(/[\\/]/)).toEqual([entry])
  })

  it("carries the sender's filename verbatim onto the child", () => {
    const plan = planAttachment(
      partsOf(
        attachedEml([
          attachment({ bytes: pdf, filename: "../../etc/passwd.pdf" }),
        ])
      )[0]
    )

    // Not sanitized here, deliberately: the name is what the reviewer has to
    // recognise, and it is the archive's business that it stops being a path.
    expect(plan.action === "expand" && plan.name).toBe("../../etc/passwd.pdf")
  })
})

describe("a message inside a message inside a message", () => {
  /** An `.eml` carried as raw bytes, which the parser walks past and the
   *  sniffer recognises. A second recursion axis: `maxNestedMessages` bounds
   *  messages our parser reads *inside* one message, and this bounds documents
   *  expansion creates *from* one. */
  function attachedMessage(inner: string, name = "inner.eml"): AttachmentSpec {
    return {
      contentType: "application/octet-stream",
      filename: name,
      bytes: bytesOf(inner),
    }
  }

  const innermost = attachedEml([attachment({ bytes: pdf })])
  const middle = attachedEml([
    attachedMessage(innermost),
    attachment({ bytes: pdf }),
  ])
  const outer = attachedEml([attachedMessage(middle, "middle.eml")])

  it("recognises an attached message from its bytes, not its content type", () => {
    const plan = planAttachment(partsOf(outer)[0])

    expect(plan.action).toBe("expand")
    if (plan.action !== "expand") return
    expect(plan.kind).toBe("eml")
  })

  it("expands one level per message rather than flattening the chain", () => {
    // Each message sees only its own attachments; the grandchildren arrive
    // when the child is itself processed, one depth at a time.
    expect(planExpansion(outer, { depth: 0 }).entries).toHaveLength(1)
    expect(planExpansion(middle, { depth: 1 }).entries).toHaveLength(2)
    expect(planExpansion(innermost, { depth: 2 }).entries).toHaveLength(1)
  })

  it("stops at the depth limit rather than recursing forever", () => {
    const limits = { ...DEFAULT_EXPANSION_LIMITS, maxDepth: 2 }

    expect(planExpansion(outer, { depth: 0, limits }).entries).toHaveLength(1)
    expect(planExpansion(middle, { depth: 1, limits }).entries).toHaveLength(2)
    expect(() => planExpansion(innermost, { depth: 2, limits })).toThrow(
      ExpansionLimitError
    )
  })
})

describe("expansion limits", () => {
  const many = (count: number): string =>
    attachedEml(
      Array.from({ length: count }, () => attachment({ bytes: pdf }))
    )

  it("refuses a message that would produce more children than allowed", () => {
    const source = many(4)

    expect(() =>
      planExpansion(source, {
        limits: { ...DEFAULT_EXPANSION_LIMITS, maxChildren: 3 },
      })
    ).toThrow(ExpansionLimitError)
  })

  it("counts refused children against the limit too", () => {
    const source = attachedEml([
      attachment({ bytes: docx, filename: "a.pdf" }),
      attachment({ bytes: docx, filename: "b.pdf" }),
    ])

    expect(() =>
      planExpansion(source, {
        limits: { ...DEFAULT_EXPANSION_LIMITS, maxChildren: 1 },
      })
    ).toThrow(ExpansionLimitError)
  })

  it("refuses a message whose attachments decode to more than the total", () => {
    expect(() =>
      planExpansion(many(3), {
        limits: {
          ...DEFAULT_EXPANSION_LIMITS,
          maxExpandedBytes: pdf.byteLength * 2,
        },
      })
    ).toThrow(ExpansionLimitError)
  })

  it("refuses to recurse past the depth limit", () => {
    const source = attachedEml([attachment({ bytes: pdf })])

    expect(() =>
      planExpansion(source, {
        depth: 2,
        limits: { ...DEFAULT_EXPANSION_LIMITS, maxDepth: 2 },
      })
    ).toThrow(ExpansionLimitError)
  })

  it("does not refuse at the depth limit when nothing would be expanded", () => {
    const source = attachedEml([
      attachment({
        bytes: unreadableBytes(),
        contentType: "application/zip",
        filename: "bundle.zip",
      }),
    ])

    const plan = planExpansion(source, {
      depth: 5,
      limits: { ...DEFAULT_EXPANSION_LIMITS, maxDepth: 2 },
    })
    expect(plan.entries.every((entry) => entry.action === "carry")).toBe(true)
  })

  it("refuses the whole message rather than expanding part of it", () => {
    let plan
    try {
      plan = planExpansion(many(30))
    } catch (error) {
      expect(error).toBeInstanceOf(ExpansionLimitError)
      expect((error as ExpansionLimitError).limit).toBe("maxChildren")
      return
    }
    expect.unreachable(`expected a refusal, got ${plan.entries.length} entries`)
  })

  it("takes environment overrides, and reports a malformed one", () => {
    const name = expansionEnvName("maxChildren")
    expect(name).toBe("ANONIFY_EML_EXPANSION_MAX_CHILDREN")

    process.env[name] = "4"
    try {
      expect(expansionLimits().maxChildren).toBe(4)
      process.env[name] = "lots"
      expect(() => expansionLimits()).toThrow(/positive whole number/)
      process.env[name] = "0"
      expect(() => expansionLimits()).toThrow(/positive whole number/)
    } finally {
      delete process.env[name]
    }
  })
})

describe("substituting a redacted attachment back into the message", () => {
  const redacted = new Uint8Array(Buffer.from("%PDF-1.4\nredacted enclosure\n"))

  function substitute(
    source: string,
    actions: Record<string, AttachmentAction>,
    plan: Partial<EmlRedactionPlan> = {}
  ): Uint8Array {
    return redactEml(bytesOf(source), emptyPlan({ attachments: actions, ...plan }))
  }

  it("puts the redacted bytes in the part, exactly", async () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = substitute(source, {
      "0.2": { action: "replace", bytes: redacted },
    })

    expect(Buffer.from(partBytes(exported, "0.2"))).toEqual(
      Buffer.from(redacted)
    )

    const checks = await verifyAttachmentSubstitutions(exported, [
      { partPath: "0.2", checksum: sha256(redacted) },
    ])
    expect(checks).toEqual([{ partPath: "0.2", passed: true, reason: null }])
  })

  it("leaves nothing of the original attachment behind", () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = substitute(source, {
      "0.2": { action: "replace", bytes: redacted },
    })

    const haystack = Buffer.from(exported).toString("latin1")
    expect(haystack).not.toContain(Buffer.from(pdf).toString("base64").slice(0, 64))
  })

  it("rewrites the transfer encoding and any declared length", () => {
    const source = attachedEml([attachment({ bytes: pdf })])
      .replace(
        "Content-Transfer-Encoding: base64",
        "Content-Transfer-Encoding: base64\r\nContent-Length: 999999"
      )

    const exported = substitute(source, {
      "0.2": { action: "replace", bytes: redacted },
    })

    expect(headerOf(exported, "0.2", "content-transfer-encoding")).toBe("base64")
    expect(headerOf(exported, "0.2", "content-length")).not.toBe("999999")
  })

  it("is still a message an independent parser can read", async () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = substitute(source, {
      "0.2": { action: "replace", bytes: redacted },
    })

    expect(await emlReparses(exported)).toBe(true)
  })

  it("substitutes each of two identical attachments on its own", async () => {
    const source = attachedEml([
      attachment({ bytes: pdf }),
      attachment({ bytes: pdf }),
    ])
    const second = new Uint8Array(Buffer.from("%PDF-1.4\nthe other one\n"))

    const exported = substitute(source, {
      "0.2": { action: "replace", bytes: redacted },
      "0.3": { action: "replace", bytes: second },
    })

    expect(Buffer.from(partBytes(exported, "0.2"))).toEqual(Buffer.from(redacted))
    expect(Buffer.from(partBytes(exported, "0.3"))).toEqual(Buffer.from(second))

    const checks = await verifyAttachmentSubstitutions(exported, [
      { partPath: "0.2", checksum: sha256(redacted) },
      { partPath: "0.3", checksum: sha256(second) },
    ])
    expect(checks.every((check) => check.passed)).toBe(true)
  })

  it("redacts the filename and replaces the body in one pass", () => {
    const source = attachedEml([
      attachment({ bytes: pdf, filename: `2026-review-${EML.person}.pdf` }),
    ])

    const exported = substitute(
      source,
      { "0.2": { action: "replace", bytes: redacted } },
      { values: [EML.person] }
    )

    const disposition = headerOf(exported, "0.2", "content-disposition")
    expect(disposition).not.toContain(EML.person)
    expect(disposition).toContain("filename")
    expect(Buffer.from(partBytes(exported, "0.2"))).toEqual(Buffer.from(redacted))
  })

  it("removes an attachment it has no redacted version of, and says so", async () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = substitute(source, {
      "0.2": { action: "remove", note: "This attachment was removed.\r\n" },
    })

    const carried = Buffer.from(partBytes(exported, "0.2")).toString("utf8")
    expect(carried).toContain("removed")
    expect(Buffer.from(exported).toString("latin1")).not.toContain(
      Buffer.from(pdf).toString("base64").slice(0, 64)
    )
    // It stops claiming to be a PDF, because it is not one any more.
    expect(headerOf(exported, "0.2", "content-type")).toContain("text/plain")
    expect(await emlReparses(exported)).toBe(true)
  })

  it("carries an attachment through byte-identically when the plan says nothing", () => {
    const source = attachedEml([
      attachment({
        bytes: unreadableBytes(),
        contentType: "application/zip",
        filename: "bundle.zip",
      }),
    ])
    const exported = substitute(source, {})

    expect(Buffer.from(exported)).toEqual(Buffer.from(bytesOf(source)))
  })
})

describe("a filename that is entirely redacted", () => {
  it("still names a part, and still carries the substituted bytes", () => {
    const redacted = new Uint8Array(Buffer.from("%PDF-1.4\nredacted\n"))
    const source = attachedEml([
      attachment({ bytes: pdf, filename: `${EML.person}.pdf` }),
    ])

    const exported = redactEml(
      bytesOf(source),
      emptyPlan({
        // Every character of the name is an accepted value bar the extension.
        values: [EML.person],
        attachments: { "0.2": { action: "replace", bytes: redacted } },
      })
    )

    expect(headerOf(exported, "0.2", "content-disposition")).not.toContain(
      EML.person
    )
    expect(Buffer.from(partBytes(exported, "0.2"))).toEqual(
      Buffer.from(redacted)
    )
  })
})

describe("verifying the substitution", () => {
  const redacted = new Uint8Array(Buffer.from("%PDF-1.4\nredacted enclosure\n"))

  it("fails when the bytes in the part are not the child artifact", async () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = redactEml(
      bytesOf(source),
      emptyPlan({
        attachments: { "0.2": { action: "replace", bytes: redacted } },
      })
    )

    const checks = await verifyAttachmentSubstitutions(exported, [
      { partPath: "0.2", checksum: sha256(new Uint8Array([1, 2, 3])) },
    ])
    expect(checks[0].passed).toBe(false)
    expect(checks[0].reason).toMatch(/does not decode/)
  })

  it("fails when the part it was supposed to land in is not there", async () => {
    const source = attachedEml([attachment({ bytes: pdf })])
    const exported = redactEml(bytesOf(source), emptyPlan())

    const checks = await verifyAttachmentSubstitutions(exported, [
      { partPath: "0.9", checksum: sha256(redacted) },
    ])
    expect(checks[0].passed).toBe(false)
    expect(checks[0].reason).toMatch(/not in the exported message/)
  })

  it("checks nothing, and refuses nothing, when there is nothing to check", async () => {
    const exported = bytesOf(attachedEml([attachment({ bytes: pdf })]))
    expect(await verifyAttachmentSubstitutions(exported, [])).toEqual([])
  })
})
