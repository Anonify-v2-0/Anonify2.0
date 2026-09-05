import { randomBytes } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import {
  decryptDocument,
  encryptDocument,
  encryptWithDocumentKey,
  openWithKey,
  sealWithKey,
} from "@/lib/storage/encryption"
import { checksumMatches, sha256 } from "@/lib/storage/integrity"
import { detectDocumentType, extensionMatchesKind } from "@/lib/documents/detect"
import { newDocumentId, randomId } from "@/lib/documents/ids"
import {
  deriveOwnerKey,
  deriveQuotaKey,
  normalizeIp,
} from "@/lib/security/fingerprint"

beforeAll(() => {
  process.env.ENCRYPTION_KEY = randomBytes(32).toString("base64")
  process.env.FINGERPRINT_SECRET = randomBytes(32).toString("hex")
})

describe("document encryption", () => {
  it("round-trips a payload through envelope encryption", () => {
    const plaintext = Buffer.from("John Smith - john@example.com")
    const { ciphertext, wrappedKey } = encryptDocument(plaintext)

    expect(ciphertext.equals(plaintext)).toBe(false)
    expect(ciphertext.toString("latin1")).not.toContain("john@example.com")
    expect(decryptDocument(ciphertext, wrappedKey).equals(plaintext)).toBe(true)
  })

  it("produces a distinct ciphertext for identical input", () => {
    const plaintext = Buffer.from("same bytes")
    const a = encryptDocument(plaintext)
    const b = encryptDocument(plaintext)

    expect(a.ciphertext.equals(b.ciphertext)).toBe(false)
    expect(a.wrappedKey).not.toBe(b.wrappedKey)
  })

  it("rejects tampered ciphertext instead of returning garbage", () => {
    const { ciphertext, wrappedKey } = encryptDocument(Buffer.from("secret"))
    ciphertext[ciphertext.length - 1] ^= 0xff

    expect(() => decryptDocument(ciphertext, wrappedKey)).toThrow()
  })

  it("rejects a ciphertext opened with the wrong document key", () => {
    const a = encryptDocument(Buffer.from("secret"))
    const b = encryptDocument(Buffer.from("other"))

    expect(() => decryptDocument(a.ciphertext, b.wrappedKey)).toThrow()
  })

  it("encrypts derived artifacts under the same document key", () => {
    const { wrappedKey } = encryptDocument(Buffer.from("source"))
    const sealed = encryptWithDocumentKey(Buffer.from("export"), wrappedKey)

    expect(decryptDocument(sealed, wrappedKey).toString()).toBe("export")
  })

  it("authenticates raw seal/open pairs", () => {
    const key = randomBytes(32)
    const sealed = sealWithKey(Buffer.from("payload"), key)

    expect(openWithKey(sealed, key).toString()).toBe("payload")
    expect(() => openWithKey(sealed, randomBytes(32))).toThrow()
  })
})

describe("integrity checksums", () => {
  it("hashes deterministically and compares safely", () => {
    const bytes = Buffer.from("document bytes")
    expect(sha256(bytes)).toBe(sha256(bytes))
    expect(checksumMatches(sha256(bytes), sha256(bytes))).toBe(true)
    expect(checksumMatches(sha256(bytes), sha256("other"))).toBe(false)
    expect(checksumMatches("", "")).toBe(false)
  })
})

describe("content sniffing", () => {
  it("identifies a PDF by its signature", () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(32)])
    expect(detectDocumentType(pdf)?.kind).toBe("pdf")
  })

  it("identifies PNG, JPEG and WebP images", () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
    ])
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.alloc(4),
      Buffer.from("WEBP"),
    ])

    expect(detectDocumentType(png)?.mimeType).toBe("image/png")
    expect(detectDocumentType(jpeg)?.mimeType).toBe("image/jpeg")
    expect(detectDocumentType(webp)?.mimeType).toBe("image/webp")
  })

  it("distinguishes DOCX from XLSX inside the zip container", () => {
    const zip = (entry: string) =>
      Buffer.concat([
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
        Buffer.from(`  ${entry}`),
      ])

    expect(detectDocumentType(zip("word/document.xml"))?.kind).toBe("docx")
    expect(detectDocumentType(zip("xl/workbook.xml"))?.kind).toBe("xlsx")
  })

  it("rejects unknown content rather than guessing", () => {
    expect(detectDocumentType(Buffer.from("just text"))).toBeNull()
  })

  it("refuses a zip that is not one of the package formats", () => {
    // An arbitrary archive renamed to .docx is still an archive, and reading
    // one as a document is how a zip bomb gets in.
    const zip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("  photos/holiday.jpg"),
    ])
    expect(detectDocumentType(zip, "contract.docx")).toBeNull()
  })

  describe("text formats", () => {
    // These have no signature to read: a CSV, a TSV and a text file are all
    // just characters. So the bytes answer the question that can be answered
    // from bytes — is this decodable text at all — and the extension picks
    // between formats the content already qualifies for.
    const csv = Buffer.from("name,email\nJohn,john@example.com\n")

    it("names a text format only when the bytes are text", () => {
      expect(detectDocumentType(csv, "people.csv")?.kind).toBe("csv")
      expect(detectDocumentType(csv, "people.tsv")?.kind).toBe("tsv")
      expect(detectDocumentType(csv, "people.txt")?.kind).toBe("txt")
    })

    it("refuses binary content whatever the name claims", () => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00])
      expect(detectDocumentType(binary, "people.csv")).toBeNull()
      expect(detectDocumentType(binary, "notes.txt")).toBeNull()
    })

    it("refuses invalid UTF-8 rather than substituting characters", () => {
      // A replacement character would mean exporting bytes that differ from
      // the ones we were handed, in places nobody asked us to touch.
      const invalid = Buffer.from([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe])
      expect(detectDocumentType(invalid, "people.csv")).toBeNull()
    })

    it("does not take a text format on the extension alone", () => {
      expect(detectDocumentType(csv, "people.exe")).toBeNull()
      expect(detectDocumentType(csv)).toBeNull()
    })
  })

  it("catches an extension that disagrees with the bytes", () => {
    expect(extensionMatchesKind("invoice.pdf", "pdf")).toBe(true)
    expect(extensionMatchesKind("invoice.pdf", "xlsx")).toBe(false)
    expect(extensionMatchesKind("invoice", "pdf")).toBe(true)
  })

  it("identifies a file the browser could not label", () => {
    // This pair is the whole reason the upload routes stopped refusing on the
    // browser's declared content type. `file.type` is a guess from an
    // extension — Windows says application/x-zip-compressed for a .docx and
    // an empty string when nothing is registered — and rejecting on it turned
    // away files the pipeline reads without difficulty. These two checks are
    // what the decision actually rests on, and neither consults the client:
    // one reads the bytes, the other compares them to the name.
    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("  word/document.xml"),
    ])

    const detected = detectDocumentType(docx)
    expect(detected?.kind).toBe("docx")
    expect(extensionMatchesKind("contract.docx", detected!.kind)).toBe(true)

    // And a file lying about what it is still does not get through.
    expect(extensionMatchesKind("contract.pdf", detected!.kind)).toBe(false)
  })
})

describe("identifiers", () => {
  it("generates unpredictable, non-sequential ids", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newDocumentId()))
    expect(ids.size).toBe(500)
    expect(randomId("doc")).toMatch(/^doc_[0-9a-zA-Z]{24}$/)
  })
})

describe("anonymous identity", () => {
  it("coarsens addresses to networks", () => {
    expect(normalizeIp("203.0.113.42")).toBe("203.0.113.0/24")
    expect(normalizeIp("203.0.113.42, 70.41.3.18")).toBe("203.0.113.0/24")
    expect(normalizeIp("2001:db8:1234:5678::1")).toBe("2001:db8:1234::/48")
    expect(normalizeIp(null)).toBe("unknown")
  })

  it("keeps ownership stable across network changes", () => {
    const session = "session-a"
    expect(deriveOwnerKey(session)).toBe(deriveOwnerKey(session))
    expect(deriveOwnerKey(session)).not.toBe(deriveOwnerKey("session-b"))
  })

  it("separates quota buckets by network", () => {
    expect(deriveQuotaKey("203.0.113.0/24", "s")).not.toBe(
      deriveQuotaKey("198.51.100.0/24", "s")
    )
  })

  it("never returns the raw session id or ip in a derived key", () => {
    const key = deriveQuotaKey("203.0.113.0/24", "session-a")
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain("session-a")
    expect(key).not.toContain("203.0.113")
  })
})
