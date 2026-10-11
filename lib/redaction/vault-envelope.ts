/**
 * A vault sealed to the browser that asked for it (#187).
 *
 * A single export used to hand its vault, the thing that reverses an
 * `encrypt` or `tokenize` copy, back in the HTTP response and store it
 * nowhere. That is what made such an export unreversible by Anonify itself.
 * Exports now run in the background and have no response to put it in, so
 * the vault is sealed to a key only the requesting page holds, and only that
 * envelope is stored:
 *
 * 1. The page makes an ephemeral ECDH P-256 key pair, its private half not
 *    extractable, and sends the public half with the request.
 * 2. The run makes its own ephemeral P-256 pair, derives a shared secret with
 *    ECDH, stretches it with HKDF-SHA256 (a random salt, and the export and
 *    variant as the info), and seals the vault with AES-256-GCM, the same
 *    info as its additional data. It keeps the envelope and lets its private
 *    key go out of scope: nothing that could open the envelope is written
 *    anywhere.
 * 3. The page derives the same key from its private half and the run's public
 *    one, and opens it.
 *
 * P-256 rather than X25519 because every browser's WebCrypto has it. Written
 * against WebCrypto alone, so the browser and the worker run the same code.
 * See docs/security-internals.md §11.
 */

export const VAULT_ENVELOPE_ALGORITHM = "ECDH-P256+HKDF-SHA256+AES-256-GCM"

export type VaultEnvelope = {
  version: 1
  algorithm: typeof VAULT_ENVELOPE_ALGORITHM
  /** The run's ephemeral public key, raw (uncompressed point), base64url. */
  serverPublicKey: string
  salt: string
  iv: string
  ciphertext: string
}

/** What the envelope is bound to: an envelope for one variant opens no other. */
export type VaultContext = { exportId: string; variant: string }

const CURVE = { name: "ECDH", namedCurve: "P-256" } as const
/** An uncompressed P-256 point: 0x04, then 32 bytes of x and 32 of y. */
const RAW_PUBLIC_KEY_BYTES = 65

function subtleCrypto(subtle?: SubtleCrypto): SubtleCrypto {
  const found = subtle ?? globalThis.crypto?.subtle
  if (!found) {
    throw new Error(
      "WebCrypto is not available here: a vault can only be opened on a page served over HTTPS or from localhost"
    )
  }
  return found
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Whether `text` is a raw P-256 public key, base64url: the shape, not the curve. */
export function looksLikeRecipientKey(text: unknown): text is string {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{80,100}$/.test(text))
    return false
  try {
    const bytes = fromBase64Url(text)
    return bytes.length === RAW_PUBLIC_KEY_BYTES && bytes[0] === 0x04
  } catch {
    return false
  }
}

function contextInfo(context: VaultContext): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `anonify-vault|${context.exportId}|${context.variant}`
  )
}

async function aesKey(
  subtle: SubtleCrypto,
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  salt: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  usage: KeyUsage
): Promise<CryptoKey> {
  const shared = await subtle.deriveBits(
    { name: "ECDH", public: publicKey },
    privateKey,
    256
  )
  const stretched = await subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ])
  return subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info },
    stretched,
    { name: "AES-GCM", length: 256 },
    false,
    [usage]
  )
}

/**
 * A key pair for the requesting page. The private half cannot be exported,
 * so it never leaves the browser's key store; the public half is sent with the
 * request.
 */
export async function newRecipientKeyPair(
  subtle?: SubtleCrypto
): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const crypto = subtleCrypto(subtle)
  const pair = (await crypto.generateKey(CURVE, false, [
    "deriveBits",
  ])) as CryptoKeyPair
  const raw = new Uint8Array(await crypto.exportKey("raw", pair.publicKey))
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) }
}

/** Seals `plaintext` to the holder of `recipientPublicKey`, and only them. */
export async function sealVaultTo(
  recipientPublicKey: string,
  plaintext: Uint8Array,
  context: VaultContext,
  subtle?: SubtleCrypto
): Promise<VaultEnvelope> {
  const crypto = subtleCrypto(subtle)
  if (!looksLikeRecipientKey(recipientPublicKey))
    throw new Error("The recipient key is not a raw P-256 public key")

  const recipient = await crypto.importKey(
    "raw",
    fromBase64Url(recipientPublicKey),
    CURVE,
    false,
    []
  )
  // Ephemeral: its private half is never exported, and goes out of scope
  // with this call.
  const ephemeral = (await crypto.generateKey(CURVE, true, [
    "deriveBits",
  ])) as CryptoKeyPair
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32))
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12))
  const info = contextInfo(context)

  const key = await aesKey(
    crypto,
    ephemeral.privateKey,
    recipient,
    salt,
    info,
    "encrypt"
  )
  const ciphertext = await crypto.encrypt(
    { name: "AES-GCM", iv, additionalData: info },
    key,
    plaintext as Uint8Array<ArrayBuffer>
  )
  const serverPublicKey = new Uint8Array(
    await crypto.exportKey("raw", ephemeral.publicKey)
  )

  return {
    version: 1,
    algorithm: VAULT_ENVELOPE_ALGORITHM,
    serverPublicKey: toBase64Url(serverPublicKey),
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(new Uint8Array(ciphertext)),
  }
}

/** Opens an envelope with the private key it was sealed to. Throws otherwise. */
export async function openVaultEnvelope(
  envelope: VaultEnvelope,
  privateKey: CryptoKey,
  context: VaultContext,
  subtle?: SubtleCrypto
): Promise<Uint8Array> {
  const crypto = subtleCrypto(subtle)
  if (envelope.version !== 1 || envelope.algorithm !== VAULT_ENVELOPE_ALGORITHM)
    throw new Error("This vault was sealed in a way this page cannot open")

  const server = await crypto.importKey(
    "raw",
    fromBase64Url(envelope.serverPublicKey),
    CURVE,
    false,
    []
  )
  const info = contextInfo(context)
  const key = await aesKey(
    crypto,
    privateKey,
    server,
    fromBase64Url(envelope.salt),
    info,
    "decrypt"
  )
  return new Uint8Array(
    await crypto.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(envelope.iv),
        additionalData: info,
      },
      key,
      fromBase64Url(envelope.ciphertext)
    )
  )
}

export function serializeEnvelope(envelope: VaultEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope))
}

export function parseEnvelope(bytes: Uint8Array): VaultEnvelope {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as VaultEnvelope
  if (parsed?.version !== 1 || parsed.algorithm !== VAULT_ENVELOPE_ALGORITHM)
    throw new Error("Not a vault envelope")
  return parsed
}
