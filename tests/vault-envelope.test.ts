import { describe, expect, it } from "vitest"

import {
  fromBase64Url,
  looksLikeRecipientKey,
  newRecipientKeyPair,
  openVaultEnvelope,
  parseEnvelope,
  sealVaultTo,
  serializeEnvelope,
  toBase64Url,
} from "@/lib/redaction/vault-envelope"

/**
 * A vault sealed to the requesting browser (#187): only its key opens it,
 * nothing the server keeps does, and an envelope is bound to its export and
 * variant.
 */

const context = { exportId: "dex_abc", variant: "encrypted" }
const vault = new TextEncoder().encode(
  JSON.stringify({ entries: [{ token: "PERSON_001", value: "Jane Doe" }] })
)

describe("the vault envelope", () => {
  it("opens with the requester's private key, and holds the vault exactly", async () => {
    const recipient = await newRecipientKeyPair()
    const envelope = await sealVaultTo(recipient.publicKey, vault, context)

    expect(new TextDecoder().decode(serializeEnvelope(envelope))).not.toContain(
      "Jane Doe"
    )
    const opened = await openVaultEnvelope(
      parseEnvelope(serializeEnvelope(envelope)),
      recipient.privateKey,
      context
    )
    expect(opened).toEqual(vault)
  })

  it("keeps the requester's private key in the key store", async () => {
    const recipient = await newRecipientKeyPair()
    expect(recipient.privateKey.extractable).toBe(false)
    await expect(
      globalThis.crypto.subtle.exportKey("pkcs8", recipient.privateKey)
    ).rejects.toThrow()
  })

  it("does not open with any other key", async () => {
    const recipient = await newRecipientKeyPair()
    const stranger = await newRecipientKeyPair()
    const envelope = await sealVaultTo(recipient.publicKey, vault, context)
    await expect(
      openVaultEnvelope(envelope, stranger.privateKey, context)
    ).rejects.toThrow()
  })

  it("is bound to its export and variant", async () => {
    const recipient = await newRecipientKeyPair()
    const envelope = await sealVaultTo(recipient.publicKey, vault, context)
    await expect(
      openVaultEnvelope(envelope, recipient.privateKey, {
        ...context,
        variant: "redacted",
      })
    ).rejects.toThrow()
    await expect(
      openVaultEnvelope(envelope, recipient.privateKey, {
        ...context,
        exportId: "dex_other",
      })
    ).rejects.toThrow()
  })

  it("refuses a tampered ciphertext", async () => {
    const recipient = await newRecipientKeyPair()
    const envelope = await sealVaultTo(recipient.publicKey, vault, context)
    const bytes = fromBase64Url(envelope.ciphertext)
    bytes[0] ^= 0xff
    await expect(
      openVaultEnvelope(
        { ...envelope, ciphertext: toBase64Url(bytes) },
        recipient.privateKey,
        context
      )
    ).rejects.toThrow()
  })

  it("uses a fresh server key, salt and IV every time", async () => {
    const recipient = await newRecipientKeyPair()
    const one = await sealVaultTo(recipient.publicKey, vault, context)
    const two = await sealVaultTo(recipient.publicKey, vault, context)
    expect(one.serverPublicKey).not.toBe(two.serverPublicKey)
    expect(one.salt).not.toBe(two.salt)
    expect(one.ciphertext).not.toBe(two.ciphertext)
  })

  it("accepts only a raw P-256 public key", async () => {
    const recipient = await newRecipientKeyPair()
    expect(looksLikeRecipientKey(recipient.publicKey)).toBe(true)
    expect(looksLikeRecipientKey("not a key")).toBe(false)
    expect(looksLikeRecipientKey(toBase64Url(new Uint8Array(65)))).toBe(false)
    await expect(sealVaultTo("nope", vault, context)).rejects.toThrow(/P-256/)
  })
})
