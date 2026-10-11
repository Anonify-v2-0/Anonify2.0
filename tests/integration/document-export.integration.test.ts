import { describe, expect, it } from "vitest"

import { hasDatabase, testFingerprint, testId } from "./support"

/**
 * A single export's artifacts and its vault (#187), against a real database
 * and the local storage driver: a retried variant overwrites its own row, the
 * stored vault is an envelope the document key cannot read, and it is handed
 * over exactly once.
 */

describe.skipIf(!hasDatabase)("background single export", async () => {
  const { prisma } = await import("@/lib/database/prisma")
  const { extractText } = await import("@/lib/documents/text/extract")
  const { saveNormalized } = await import("@/lib/documents/normalized-store")
  const { exportAndStore } = await import("@/lib/redaction/deliver")
  const { defaultVariant, nameVariants } =
    await import("@/lib/redaction/variants")
  const { categoriesAllowing } = await import("@/lib/redaction/methods")
  const { toDatabaseRow } = await import("@/lib/redaction/model")
  const { parseVault } = await import("@/lib/redaction/vault")
  const { newRecipientKeyPair, openVaultEnvelope, parseEnvelope } =
    await import("@/lib/redaction/vault-envelope")
  const { artifactIdFor, documentExportView, takeVaultEnvelope } =
    await import("@/lib/documents/document-exports")
  const { sourceKey, vaultKey, getObject } = await import("@/lib/storage/blob")
  const { documentSeal, getSealed, newDocumentSeal, putSealed } =
    await import("@/lib/storage/sealed")
  const { sha256 } = await import("@/lib/storage/integrity")

  const NAME = "Margaret Holloway"
  const EMAIL = "margaret.holloway@example.org"

  async function readyDocument(owner: string): Promise<string> {
    const id = testId("doc")
    const text = `Letter for ${NAME}. Reply to ${EMAIL} by Friday.\n`
    const bytes = new TextEncoder().encode(text)
    const seal = newDocumentSeal()
    const stored = await putSealed(sourceKey(id), bytes, seal)
    await prisma.document.create({
      data: {
        id,
        originalName: "letter.txt",
        kind: "txt",
        mimeType: "text/plain",
        size: bytes.byteLength,
        status: "ready",
        userFingerprint: owner,
        quotaKey: null,
        sourceBlobKey: stored.key,
        encryptionKey: seal.wrappedKey,
        encryptionFormat: seal.format,
        checksum: sha256(bytes),
        ttlSeconds: 3600,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    const model = extractText(id, bytes).document
    const saved = await saveNormalized(id, seal, model)
    const page = model.pages[0]
    await prisma.redaction.createMany({
      data: [
        { value: NAME, category: "person" },
        { value: EMAIL, category: "email" },
      ].map(({ value, category }) => {
        const start = (page.text ?? "").indexOf(value)
        return {
          ...toDatabaseRow({
            id: testId("red"),
            documentId: id,
            type: "text",
            source: "user",
            category: category as never,
            status: "accepted",
            page: page.number,
            text: value,
            start,
            end: start + value.length,
          }),
          metadata: {},
        }
      }),
    })
    await prisma.document.update({
      where: { id },
      data: { normalizedBlobKey: saved.key, normalizedIndex: saved.index },
    })
    return id
  }

  it("stores one row per variant, a vault the document key cannot read, handed over once", async () => {
    const owner = testFingerprint("single-export")
    const documentId = await readyDocument(owner)
    const recipient = await newRecipientKeyPair()
    const base = {
      addLabels: false,
      sanitizeMetadata: true,
      imageStyle: "solid" as const,
    }
    const variants = nameVariants([
      base,
      { ...base, methods: categoriesAllowing("encrypt") },
    ])
    const exportId = testId("dex")
    await prisma.documentExport.create({
      data: {
        id: exportId,
        documentId,
        status: "running",
        variants,
        recipientKey: recipient.publicKey,
      },
    })

    // Each variant as its step runs it, the first one twice: a retry.
    const runVariant = (index: number) =>
      exportAndStore(documentId, [variants[index]], {
        recipientKey: recipient.publicKey,
        exportId,
        artifactIds: [artifactIdFor(exportId, index)],
        updatePointer: index === 0,
      })
    expect((await runVariant(0)).ok).toBe(true)
    expect((await runVariant(0)).ok).toBe(true)
    const second = await runVariant(1)
    expect(second.ok).toBe(true)
    expect(await prisma.exportArtifact.count({ where: { exportId } })).toBe(2)

    await prisma.documentExport.update({
      where: { id: exportId },
      data: { status: "ready" },
    })
    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
    })
    const view = await documentExportView(
      (await prisma.documentExport.findUniqueOrThrow({
        where: { id: exportId },
      }))!,
      document
    )
    const encrypted = view.artifacts!.find((artifact) => artifact.vaultUrl)!
    expect(encrypted).toBeDefined()
    expect(
      view.artifacts!.filter((artifact) => artifact.vaultUrl)
    ).toHaveLength(1)

    // What is stored opens, with the document's key, only as far as an
    // envelope: not a vault, and not the values.
    const row = await prisma.exportArtifact.findUniqueOrThrow({
      where: { id: encrypted.artifactId },
    })
    expect(row.vaultRecipient).toBe(true)
    const stored = await getSealed(
      row.vaultBlobKey!,
      vaultKey(documentId, row.id),
      documentSeal(document)
    )
    // An envelope, and read as a vault it holds no key and no entries.
    expect(parseEnvelope(stored).algorithm).toMatch(/ECDH-P256/)
    const misread = parseVault(stored)
    expect(misread.key).toBeNull()
    expect(misread.entries).toEqual([])
    const storedText = new TextDecoder().decode(stored)
    expect(storedText).not.toContain(NAME)
    expect(storedText).not.toContain(EMAIL)

    // The browser's key opens it, and it holds the key that reverses the copy.
    const taken = await takeVaultEnvelope(document, exportId, row.id)
    const opened = parseVault(
      await openVaultEnvelope(parseEnvelope(taken!), recipient.privateKey, {
        exportId,
        variant: encrypted.variant,
      })
    )
    expect(opened.key).toBeTruthy()

    // Once: the row no longer names it, and the object is gone.
    expect(await takeVaultEnvelope(document, exportId, row.id)).toBeNull()
    await expect(getObject(row.vaultBlobKey!)).rejects.toThrow()
    const after = await documentExportView(
      (await prisma.documentExport.findUniqueOrThrow({
        where: { id: exportId },
      }))!,
      document
    )
    expect(after.artifacts!.every((artifact) => !artifact.vaultUrl)).toBe(true)

    // The first variant's artifact is the document's pointer.
    expect(document.processedChecksum).toBe(
      view.artifacts!.find((artifact) => !artifact.vaultUrl)!.checksum
    )

    await prisma.document.delete({ where: { id: documentId } })
  })

  it("seals nothing to anyone when no variant is reversible", async () => {
    const owner = testFingerprint("plain-export")
    const documentId = await readyDocument(owner)
    const recipient = await newRecipientKeyPair()
    const exportId = testId("dex")
    const variants = [
      defaultVariant({
        addLabels: false,
        sanitizeMetadata: true,
        imageStyle: "solid",
      }),
    ]
    await prisma.documentExport.create({
      data: {
        id: exportId,
        documentId,
        variants,
        recipientKey: recipient.publicKey,
      },
    })
    await exportAndStore(documentId, variants, {
      recipientKey: recipient.publicKey,
      exportId,
      artifactIds: [artifactIdFor(exportId, 0)],
    })
    const row = await prisma.exportArtifact.findFirstOrThrow({
      where: { exportId },
    })
    expect(row.vaultBlobKey).toBeNull()
    expect(row.vaultRecipient).toBe(false)
    await prisma.document.delete({ where: { id: documentId } })
  })
})
