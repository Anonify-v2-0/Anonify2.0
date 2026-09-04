import { randomBytes } from "node:crypto"

import { beforeAll, describe, expect, it } from "vitest"

import {
  createDownloadToken,
  verifyDownloadToken,
} from "@/lib/security/signed-url"

beforeAll(() => {
  process.env.FINGERPRINT_SECRET = randomBytes(32).toString("hex")
})

const base = {
  documentId: "doc_1",
  artifactId: "exp_1",
  ownerKey: "owner_1",
}

describe("download tokens", () => {
  it("round-trips the values it authorizes", () => {
    const verified = verifyDownloadToken(createDownloadToken(base))

    expect(verified?.documentId).toBe("doc_1")
    expect(verified?.artifactId).toBe("exp_1")
    expect(verified?.ownerKey).toBe("owner_1")
  })

  it("rejects a token whose payload was edited", () => {
    const token = createDownloadToken(base)
    const [payload, signature] = token.split(".")
    const forged = Buffer.from(
      Buffer.from(payload, "base64url").toString("utf8").replace("doc_1", "doc_2")
    ).toString("base64url")

    expect(verifyDownloadToken(`${forged}.${signature}`)).toBeNull()
  })

  it("rejects a token signed with a different secret", () => {
    const token = createDownloadToken(base)
    process.env.FINGERPRINT_SECRET = randomBytes(32).toString("hex")
    expect(verifyDownloadToken(token)).toBeNull()
  })

  it("rejects an expired token", () => {
    const token = createDownloadToken({ ...base, ttlSeconds: -1 })
    expect(verifyDownloadToken(token)).toBeNull()
  })

  it("rejects malformed input rather than throwing", () => {
    expect(verifyDownloadToken("")).toBeNull()
    expect(verifyDownloadToken("nonsense")).toBeNull()
    expect(verifyDownloadToken("a.b.c")).toBeNull()
  })
})
