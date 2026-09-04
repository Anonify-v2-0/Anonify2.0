const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * Browser-side id generation, using the Web Crypto API rather than node:crypto
 * so client bundles never pull in a Node polyfill. Ids minted here are local
 * until the server persists them.
 */
export function randomClientId(prefix: string, length = 16): string {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)

  let out = ""
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return `${prefix}_${out}`
}
