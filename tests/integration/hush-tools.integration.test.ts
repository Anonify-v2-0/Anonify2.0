import { afterAll, describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * Hush's tools against Postgres, called the way the agent calls them.
 *
 * What is held down: occurrences say truthfully whether they are covered,
 * the missed-value scan leaves out what is already redacted, a redaction is
 * written only where the text at a reference is the text that was approved,
 * and a bulk decision touches exactly the groups it names.
 */

const { prisma } = await import("@/lib/database/prisma")
const { saveNormalized } = await import("@/lib/documents/normalized-store")
const { newDocumentSeal } = await import("@/lib/storage/sealed")
const { newRedactionId } = await import("@/lib/documents/ids")
const { hushTools } = await import("@/lib/assistant/tools")
const { asTarget, RULE_TARGET_SELECT } = await import("@/lib/redaction/rules")

const owners: string[] = []
const TEXT = "Contact jane@example.com or bob@example.com. Staff EMP-00123."

async function seed(text = TEXT) {
  const ownerKey = testFingerprint("hush-tools")
  owners.push(ownerKey)
  const id = testId("doc")
  const seal = newDocumentSeal()
  await prisma.document.create({
    data: {
      id,
      originalName: "notes.txt",
      kind: "txt",
      mimeType: "text/plain",
      size: text.length,
      status: "ready",
      userFingerprint: ownerKey,
      encryptionKey: seal.wrappedKey,
      encryptionFormat: seal.format,
      ttlSeconds: 3600,
      expiresAt: new Date(Date.now() + 3600 * 1000),
    },
  })
  const saved = await saveNormalized(id, seal, {
    documentId: id,
    kind: "txt",
    pages: [
      {
        number: 1,
        width: 612,
        height: 792,
        text,
        spans: [{ id: "s1", text, start: 0, end: text.length }],
      },
    ],
  })
  await prisma.document.update({
    where: { id },
    data: { normalizedBlobKey: saved.key, normalizedIndex: saved.index },
  })
  const row = await prisma.document.findUniqueOrThrow({
    where: { id },
    select: RULE_TARGET_SELECT,
  })
  const tools = hushTools({
    documentId: id,
    target: asTarget(row)!,
    batchId: null,
    ownerKey,
    name: "notes.txt",
    kind: "txt",
  })
  return { id, tools }
}

/** Calls a tool the way the agent loop does, minus the model. */
async function call<T>(
  tool: { execute?: (...args: never[]) => unknown },
  input: unknown
): Promise<T> {
  const execute = tool.execute as unknown as (
    input: unknown,
    options: unknown
  ) => Promise<T>
  return execute(input, { toolCallId: "test", messages: [] })
}

async function suggest(
  documentId: string,
  text: string,
  start: number,
  category = "email",
  decided: { status?: string; source?: string } = {}
) {
  await prisma.redaction.create({
    data: {
      id: newRedactionId(),
      documentId,
      source: decided.source ?? "ai",
      type: "text",
      category,
      status: decided.status ?? "suggested",
      page: 1,
      text,
      startOffset: start,
      endOffset: start + text.length,
      metadata: {},
    },
  })
}

describe.skipIf(!hasDatabase)("Hush's tools against Postgres", () => {
  afterAll(async () => {
    for (const value of owners) {
      await prisma.document.deleteMany({ where: { userFingerprint: value } })
    }
  })

  it("lists occurrences with where they are and whether they are covered", async () => {
    const { id, tools } = await seed()
    await suggest(id, "jane@example.com", TEXT.indexOf("jane"))

    const result = await call<{
      total: number
      uncovered: number
      occurrences: { ref: string; text: string; covered: string | null }[]
    }>(tools.find_occurrences, {
      kind: "regex",
      pattern: "\\w+@example\\.com",
      matchCase: false,
      wholeWord: true,
      limit: 50,
    })

    expect(result.total).toBe(2)
    expect(result.uncovered).toBe(1)
    expect(
      result.occurrences.map((occurrence) => [
        occurrence.text,
        occurrence.covered,
      ])
    ).toEqual([
      ["jane@example.com", "suggested"],
      ["bob@example.com", null],
    ])
    expect(result.occurrences[1].ref).toBe(
      `p1:${TEXT.indexOf("bob")}-${TEXT.indexOf("bob") + 15}`
    )
  })

  it("counts a place only partly redacted as not covered", async () => {
    const { id, tools } = await seed()
    // The reviewer clicked "jane"; the rest of the address is still in the file.
    await suggest(id, "jane", TEXT.indexOf("jane"), "email", {
      status: "accepted",
      source: "user",
    })

    const found = await call<{
      uncovered: number
      occurrences: { text: string; covered: string | null }[]
    }>(tools.find_occurrences, {
      kind: "literal",
      pattern: "jane@example.com",
      matchCase: false,
      wholeWord: true,
      limit: 50,
    })
    expect(found.uncovered).toBe(1)
    expect(found.occurrences.map((occurrence) => occurrence.covered)).toEqual([
      "partial",
    ])

    const scan = await call<{ groups: { value: string }[] }>(
      tools.find_uncovered,
      {}
    )
    expect(scan.groups.map((group) => group.value)).toContain(
      "jane@example.com"
    )
  })

  it("covers a value redacted word by word, at the least decided word's level", async () => {
    const text = "Signed by Jane Doe and Mary Roe."
    const { id, tools } = await seed(text)
    const words = { status: "accepted", source: "user" }
    await suggest(id, "Jane", text.indexOf("Jane"), "person", words)
    await suggest(id, "Doe", text.indexOf("Doe"), "person", words)
    await suggest(id, "Mary", text.indexOf("Mary"), "person", words)
    await suggest(id, "Roe", text.indexOf("Roe"), "person")

    const found = await call<{
      uncovered: number
      occurrences: { text: string; covered: string | null }[]
    }>(tools.find_occurrences, {
      kind: "regex",
      pattern: "(Jane Doe|Mary Roe)",
      matchCase: true,
      wholeWord: true,
      limit: 50,
    })
    expect(found.uncovered).toBe(0)
    expect(
      found.occurrences.map((occurrence) => [
        occurrence.text,
        occurrence.covered,
      ])
    ).toEqual([
      ["Jane Doe", "accepted"],
      ["Mary Roe", "suggested"],
    ])
  })

  it("scans for what is not yet covered, leaving out what is", async () => {
    const { id, tools } = await seed()
    await suggest(id, "jane@example.com", TEXT.indexOf("jane"))

    const result = await call<{
      groups: { category: string; value: string }[]
    }>(tools.find_uncovered, {})
    const values = result.groups.map((group) => group.value)
    expect(values).toContain("bob@example.com")
    expect(values).not.toContain("jane@example.com")
  })

  it("counts a value the reviewer rejected as not covered, everywhere", async () => {
    const { id, tools } = await seed()
    await suggest(id, "jane@example.com", TEXT.indexOf("jane"))
    await prisma.redaction.updateMany({ where: { documentId: id }, data: { status: "rejected" } })

    const found = await call<{ uncovered: number; occurrences: { covered: string | null }[] }>(
      tools.find_occurrences,
      { kind: "literal", pattern: "@example.com", matchCase: false, wholeWord: false, limit: 1 }
    )
    // Both, though only one is listed: the count is over every occurrence.
    expect(found.uncovered).toBe(2)
    expect(found.occurrences).toHaveLength(1)

    const scan = await call<{ groups: { value: string }[] }>(tools.find_uncovered, {})
    expect(scan.groups.map((group) => group.value)).toContain("jane@example.com")
  })

  it("redacts only where the text at a reference is the text that was approved", async () => {
    const { id, tools } = await seed()
    const start = TEXT.indexOf("EMP-00123")
    const result = await call<{ redacted: number; refused: { ref: string }[] }>(
      tools.redact_occurrences,
      {
        items: [
          { ref: `p1:${start}-${start + 9}`, text: "EMP-00123" },
          // The model copied the wrong text for this place.
          { ref: `p1:0-7`, text: "Invoice" },
          { ref: "not-a-ref", text: "x" },
        ],
        category: "customer-id",
        reason: "Employee number",
      }
    )

    expect(result.redacted).toBe(1)
    expect(result.refused.map((entry) => entry.ref)).toEqual([
      "p1:0-7",
      "not-a-ref",
    ])
    const [row] = await prisma.redaction.findMany({ where: { documentId: id } })
    expect(row).toMatchObject({
      text: "EMP-00123",
      status: "accepted",
      source: "ai",
      startOffset: start,
    })
  })

  it("decides exactly the suggestion groups it names", async () => {
    const { id, tools } = await seed()
    await suggest(id, "jane@example.com", TEXT.indexOf("jane"))
    await suggest(id, "bob@example.com", TEXT.indexOf("bob"))

    const result = await call<{ updated: number }>(
      tools.set_suggestion_status,
      {
        keys: ["email|jane@example.com"],
        status: "rejected",
        reason: "Public contact address",
      }
    )

    expect(result.updated).toBe(1)
    const rows = await prisma.redaction.findMany({
      where: { documentId: id },
      orderBy: { startOffset: "asc" },
    })
    expect(rows.map((row) => [row.text, row.status])).toEqual([
      ["jane@example.com", "rejected"],
      ["bob@example.com", "suggested"],
    ])
  })
})
