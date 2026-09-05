import { randomBytes } from "node:crypto"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

/**
 * Unpredictable, non-sequential identifiers. Document ids appear in URLs, so
 * guessing one must not be feasible — access control still applies on top.
 */
export function randomId(prefix: string, length = 24): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
  }
  return `${prefix}_${out}`
}

export const newDocumentId = () => randomId("doc")
export const newRedactionId = () => randomId("red", 16)
export const newRuleId = () => randomId("rule", 16)
export const newBatchId = () => randomId("bat")
export const newBatchRuleId = () => randomId("brl", 16)
export const newBatchExportId = () => randomId("bex", 16)
export const newEventId = () => randomId("evt", 16)
export const newUsageId = () => randomId("use", 16)
