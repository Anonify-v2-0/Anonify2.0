import { describe, expect, it } from "vitest"

import { extractText } from "@/lib/documents/text/extract"
import { redactText } from "@/lib/documents/text/redact"
import { buildTextPlan } from "@/lib/redaction/apply"
import {
  carriesSubstitutableText,
  methodsFor,
  resolveMethod,
  surrogateCarrier,
  usesShortSurrogate,
} from "@/lib/redaction/methods"
import { restoreDocument } from "@/lib/redaction/restore"
import { buildSurrogates } from "@/lib/redaction/surrogates"
import { verifyExport } from "@/lib/redaction/validation"
import {
  buildVault,
  CIPHERTEXT_PATTERN,
  decodeValueKey,
  decryptValue,
  parseVault,
  serializeVault,
} from "@/lib/redaction/vault"
import { nameVariants } from "@/lib/redaction/variants"
import type { Redaction, RedactionMethod } from "@/types/redaction"

import { SENSITIVE } from "./fixtures"

/**
 * Anonymisation beyond masking.
 *
 * Two properties this suite exists to protect, and they pull in opposite
 * directions. The first is that a softer method is only ever offered where it
 * is defensible — a face, a government ID, a region with nothing recognised
 * behind it gets removal and nothing else, whatever anybody asked for. The
 * second is that where a method *is* offered it actually works end to end,
 * including back: a tokenised document plus its vault has to reproduce the
 * original, or the vault was a promise nobody kept.
 *
 * Between them sits the invariant neither is allowed to break: whatever the
 * method, the accepted value is not in the exported bytes.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const bytes = (text: string) => encoder.encode(text)
const textOf = (output: Uint8Array) => decoder.decode(output)

const OPTIONS = { addLabels: false, sanitizeMetadata: true }

const SOURCE = [
  "Client notes",
  "",
  `Name: ${SENSITIVE.person}`,
  `Email: ${SENSITIVE.email}`,
  `Account: ${SENSITIVE.account}`,
  `Repeat: ${SENSITIVE.person}`,
  "",
].join("\n")

function redaction(overrides: Partial<Redaction> = {}): Redaction {
  return {
    id: `red-${Math.random().toString(36).slice(2)}`,
    documentId: "doc",
    type: "text",
    source: "ai",
    category: "person",
    status: "accepted",
    text: SENSITIVE.person,
    ...overrides,
  }
}

/** A redaction over the first occurrence of `value` in the parsed source. */
function redactionFor(
  model: ReturnType<typeof extractText>["document"],
  value: string,
  overrides: Partial<Redaction> = {}
): Redaction {
  for (const page of model.pages) {
    const index = page.text.indexOf(value)
    if (index === -1) continue
    return redaction({
      page: page.number,
      start: index,
      end: index + value.length,
      text: value,
      ...overrides,
    })
  }
  throw new Error(`${value} is not in the fixture`)
}

/** One text export, from redactions to bytes, the way the pipeline does it. */
function exportText(redactions: Redaction[]): {
  output: Uint8Array
  surrogates: ReturnType<typeof buildSurrogates>
} {
  const { document } = extractText("doc", bytes(SOURCE))
  const surrogates = buildSurrogates(redactions, "txt")
  const plan = buildTextPlan(document, redactions, { ...OPTIONS, surrogates })
  return { output: redactText(bytes(SOURCE), plan), surrogates }
}

describe("which methods a redaction may be given", () => {
  it("offers every method a permissive category allows", () => {
    expect(methodsFor(redaction({ category: "person" }))).toEqual([
      "mask",
      "pseudonymize",
      "tokenize",
      "encrypt",
    ])
  })

  it.each<[string, string]>([
    ["government-id", "AB123456C"],
    ["bank-account", "12345678"],
    ["financial", "4111111111111111"],
    ["api-key", "sk-live-abcdef"],
  ])(
    "offers nothing but masking for %s, whose removal is the whole point",
    (category, text) => {
      expect(methodsFor(redaction({ category, text }))).toEqual(["mask"])
    }
  )

  it("gives address and date-of-birth encryption but not a stable surrogate", () => {
    // A surrogate that is consistent across a file re-identifies by joining,
    // and a birth date or a street is exactly what somebody would join on.
    expect(methodsFor(redaction({ category: "address", text: "12 Mill Lane" })))
      .toEqual(["mask", "encrypt"])
    expect(
      methodsFor(redaction({ category: "date-of-birth", text: "1980-01-01" }))
    ).toEqual(["mask", "encrypt"])
  })

  it("masks a face, which has no text for a surrogate to replace", () => {
    const face = redaction({ category: "face", type: "face", text: undefined })
    expect(carriesSubstitutableText(face)).toBe(false)
    expect(methodsFor(face)).toEqual(["mask"])
  })

  it("masks a region OCR found nothing behind, however it is categorised", () => {
    // The case that looks identical to a substitutable one in the model: a
    // bounding box on a photograph, categorised `person`, with no text.
    const region = redaction({
      category: "person",
      type: "region",
      text: undefined,
      boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    })
    expect(methodsFor(region)).toEqual(["mask"])
  })

  it("masks a whole column, whose text is a header it keeps on purpose", () => {
    const column = redaction({ category: "email", type: "column", text: "Email" })
    expect(methodsFor(column)).toEqual(["mask"])
  })

  it("falls back to masking when a stored method is no longer allowed", () => {
    // The category was corrected after the reviewer chose. Falling back to
    // removal is always safe; the other direction never is.
    const corrected = redaction({
      category: "government-id",
      method: "tokenize",
      text: "AB123456C",
    })
    expect(resolveMethod(corrected)).toBe("mask")
  })

  it("lets a variant override a method by category", () => {
    const stored = redaction({ method: "mask" })
    expect(resolveMethod(stored, { person: "tokenize" })).toBe("tokenize")
  })

  it("refuses an override the category does not permit", () => {
    const face = redaction({ category: "face", type: "face", text: undefined })
    expect(resolveMethod(face, { face: "tokenize" })).toBe("mask")
  })
})

describe("where a surrogate can be put", () => {
  it("writes into the text of a format that holds characters", () => {
    for (const kind of ["docx", "xlsx", "pptx", "txt", "csv", "tsv", "rtf", "eml"] as const) {
      expect(surrogateCarrier(kind)).toBe("text")
      expect(usesShortSurrogate(kind)).toBe(false)
    }
  })

  it("paints onto the strip for a format that has no text left", () => {
    // The bypass: a rasterised PDF page and an image have no text stream, but
    // the strip covering the value is a rectangle this pipeline draws.
    for (const kind of ["pdf", "image"] as const) {
      expect(surrogateCarrier(kind)).toBe("raster")
      expect(usesShortSurrogate(kind)).toBe(true)
    }
  })

  it("puts a reference on a strip and the ciphertext in the vault", () => {
    const accepted = [redaction({ method: "encrypt" })]
    const surrogates = buildSurrogates(accepted, "image")

    const painted = surrogates.forRedaction(accepted[0])
    expect(painted).toMatch(/^ENC_\d{3}$/)

    // The strip could not have held the ciphertext, so the vault does.
    const entry = surrogates.vaultEntries.find(
      (candidate) => candidate.surrogate === painted
    )
    expect(entry?.method).toBe("encrypt")
    expect(surrogates.key).not.toBeNull()
    expect(
      decryptValue(
        entry?.method === "encrypt" ? entry.ciphertext : "",
        surrogates.key as Buffer
      )
    ).toBe(SENSITIVE.person)
  })

  it("writes the ciphertext inline where the format can hold it", () => {
    const accepted = [redaction({ method: "encrypt" })]
    const surrogates = buildSurrogates(accepted, "txt")

    expect(surrogates.forRedaction(accepted[0])).toMatch(/^ENC\[[A-Za-z0-9_-]+\]$/)
    // Nothing to put in the vault: the ciphertext is in the document, and the
    // key alone reverses it.
    expect(surrogates.vaultEntries).toEqual([])
  })
})

describe("one method per value, across the whole document", () => {
  it("gives every occurrence of a value the same surrogate", () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const first = redactionFor(document, SENSITIVE.person, {
      method: "pseudonymize",
    })

    const { output } = exportText([first])
    const restored = textOf(output)

    // Two occurrences in the fixture, one of them never reviewed — the sweep
    // found it, and it has to read as the same person.
    expect(restored.match(/PERSON_001/g)).toHaveLength(2)
    expect(restored).not.toContain(SENSITIVE.person)
  })

  it("masks a value when any of its redactions asks for removal", () => {
    // Two decisions about one string. Losing a pseudonym is a cost;
    // substituting where somebody asked to remove is not a trade we make.
    const accepted = [
      redaction({ method: "tokenize" }),
      redaction({ method: "mask" }),
    ]
    const surrogates = buildSurrogates(accepted, "txt")

    expect(surrogates.methodOf(accepted[0])).toBe("mask")
    expect(surrogates.forRedaction(accepted[0])).toBeUndefined()
    expect(surrogates.vaultEntries).toEqual([])
  })

  it("numbers surrogates stably, whatever order the rows arrived in", () => {
    const forward = buildSurrogates(
      [
        redaction({ text: "Alice Adams", method: "pseudonymize" }),
        redaction({ text: "Bob Brown", method: "pseudonymize" }),
      ],
      "txt"
    )
    const reversed = buildSurrogates(
      [
        redaction({ text: "Bob Brown", method: "pseudonymize" }),
        redaction({ text: "Alice Adams", method: "pseudonymize" }),
      ],
      "txt"
    )

    expect(forward.forValue("Alice Adams")).toBe(reversed.forValue("Alice Adams"))
    expect(forward.forValue("Bob Brown")).toBe(reversed.forValue("Bob Brown"))
  })

  it("encrypts the same value differently each time it is exported", () => {
    // A deterministic cipher would leak equality to everyone rather than to
    // the key holder, which is what `pseudonymize` is for.
    const accepted = [redaction({ method: "encrypt" })]
    const first = buildSurrogates(accepted, "txt").forRedaction(accepted[0])
    const second = buildSurrogates(accepted, "txt").forRedaction(accepted[0])
    expect(first).not.toBe(second)
  })
})

describe("the value is gone whatever the method", () => {
  it.each<RedactionMethod>(["mask", "pseudonymize", "tokenize", "encrypt"])(
    "removes the accepted value under %s",
    async (method) => {
      const { document } = extractText("doc", bytes(SOURCE))
      const accepted = [
        redactionFor(document, SENSITIVE.person, { method }),
        redactionFor(document, SENSITIVE.email, { category: "email", method }),
      ]

      const { output, surrogates } = exportText(accepted)
      const restored = textOf(output)

      expect(restored).not.toContain(SENSITIVE.person)
      expect(restored).not.toContain(SENSITIVE.email)

      const verification = await verifyExport(
        "txt",
        output,
        accepted,
        [],
        surrogates.substitutions
      )
      expect(verification.passed).toBe(true)
    }
  )

  it("does not mistake a ciphertext for the value it replaced", async () => {
    // The false positive this guards against: a base64url ciphertext is long
    // and arbitrary, and a four-character accepted value can occur inside one
    // by coincidence. Verification must not refuse a correct export over that.
    const accepted = [redaction({ text: "John", method: "encrypt" })]
    const surrogates = buildSurrogates(accepted, "txt")
    const ciphertext = surrogates.forRedaction(accepted[0]) as string

    const forged = bytes(`A line holding ${ciphertext} and nothing else.\n`)
    const verification = await verifyExport(
      "txt",
      forged,
      accepted,
      [],
      surrogates.substitutions
    )

    expect(verification.passed).toBe(true)
  })

  it("leaves an accepted value outside a substitution detectable", async () => {
    // The other half of the same check: excising what we wrote must not blind
    // the verifier to what the document said.
    const accepted = [redaction({ method: "tokenize" })]
    const surrogates = buildSurrogates(accepted, "txt")

    const leaking = bytes(`Still says ${SENSITIVE.person} here.\n`)
    const verification = await verifyExport(
      "txt",
      leaking,
      accepted,
      [],
      surrogates.substitutions
    )

    expect(verification.passed).toBe(false)
    expect(verification.leaked).toContain(SENSITIVE.person)
  })
})

describe("the vault, and getting back", () => {
  it("round-trips a tokenized document through the vault", async () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const accepted = [
      redactionFor(document, SENSITIVE.person, { method: "tokenize" }),
      redactionFor(document, SENSITIVE.email, {
        category: "email",
        method: "tokenize",
      }),
    ]

    const { output, surrogates } = exportText(accepted)
    expect(textOf(output)).not.toContain(SENSITIVE.person)

    const vault = buildVault({
      documentId: "doc",
      artifactChecksum: "",
      key: surrogates.key,
      entries: surrogates.vaultEntries,
    })

    const outcome = await restoreDocument({ kind: "txt", bytes: output, vault })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // Every occurrence comes back, including the one nobody reviewed.
    expect(textOf(outcome.bytes)).toBe(SOURCE)
    expect(outcome.unresolved).toBe(0)
  })

  it("round-trips an encrypted document through the key alone", async () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const accepted = [
      redactionFor(document, SENSITIVE.person, { method: "encrypt" }),
    ]

    const { output, surrogates } = exportText(accepted)
    expect(textOf(output)).toMatch(CIPHERTEXT_PATTERN)

    const vault = buildVault({
      documentId: "doc",
      artifactChecksum: "",
      key: surrogates.key,
      // No entries at all: the ciphertext is in the document.
      entries: [],
    })

    const outcome = await restoreDocument({ kind: "txt", bytes: output, vault })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(textOf(outcome.bytes)).toBe(SOURCE)
  })

  it("survives being written out and read back", () => {
    const built = buildVault({
      documentId: "doc",
      artifactChecksum: "abc",
      key: null,
      entries: [
        {
          method: "tokenize",
          surrogate: "PERSON_001",
          category: "person",
          value: SENSITIVE.person,
        },
      ],
    })

    const parsed = parseVault(serializeVault(built))
    expect(parsed.entries).toEqual(built.entries)
  })

  it("refuses a vault whose key is the wrong length", () => {
    expect(() => decodeValueKey("too-short")).toThrow()
  })

  it("restores nothing from a pseudonymized document, and says so", async () => {
    const { document } = extractText("doc", bytes(SOURCE))
    const accepted = [
      redactionFor(document, SENSITIVE.person, { method: "pseudonymize" }),
    ]
    const { output } = exportText(accepted)

    const outcome = await restoreDocument({
      kind: "txt",
      bytes: output,
      vault: buildVault({
        documentId: "doc",
        artifactChecksum: "",
        key: null,
        entries: [],
      }),
    })

    expect(outcome).toEqual({ ok: false, reason: "nothing-to-restore" })
  })

  it("refuses to restore a rasterised format rather than pretending", async () => {
    const outcome = await restoreDocument({
      kind: "pdf",
      bytes: bytes("%PDF-1.4\n"),
      vault: buildVault({
        documentId: "doc",
        artifactChecksum: "",
        key: null,
        entries: [],
      }),
    })

    expect(outcome).toEqual({ ok: false, reason: "unsupported-format" })
  })
})

describe("naming the outputs of one review", () => {
  it("names a variant for what it does rather than what it is called", () => {
    const named = nameVariants([
      { addLabels: false, sanitizeMetadata: true },
      { addLabels: false, sanitizeMetadata: true, methods: { person: "tokenize" } },
      {
        addLabels: false,
        sanitizeMetadata: true,
        methods: { person: "encrypt", email: "tokenize" },
      },
    ])

    expect(named.map((variant) => variant.name)).toEqual([
      "redacted",
      "tokenized",
      "mixed",
    ])
  })

  it("disambiguates two variants that deserve the same name", () => {
    const named = nameVariants([
      { addLabels: false, sanitizeMetadata: true, methods: { person: "tokenize" } },
      { addLabels: false, sanitizeMetadata: true, methods: { email: "tokenize" } },
    ])

    expect(named.map((variant) => variant.name)).toEqual([
      "tokenized",
      "tokenized-2",
    ])
  })
})
