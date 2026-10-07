import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * Uploads straight to the bucket, and what happens when the bucket will not
 * take them from a browser (#185): the CORS rules /api/ready reads, and the
 * page falling back to the app's own route.
 */

const sent = vi.hoisted(() => ({
  reply: (() => ({})) as (name: string) => unknown,
}))

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(public input: Record<string, unknown>) {}
  }
  const named = (name: string) =>
    class extends Command {
      commandName = name
    }
  return {
    S3Client: class {
      async send(command: { commandName: string }) {
        return sent.reply(command.commandName)
      }
    },
    GetBucketCorsCommand: named("GetBucketCors"),
  }
})

const { CorsRefusal, corsRefusal } = await import("@/lib/storage/cors")
const { createS3Driver } = await import("@/lib/storage/drivers")
const { uploadStraightToStorage, uploadThroughServer } =
  await import("@/components/upload/send")

const ORIGIN = "https://redact.example.org"

afterEach(() => {
  sent.reply = () => ({})
  vi.unstubAllGlobals()
})

describe("reading CORS rules for a direct upload", () => {
  const rule = (overrides: Partial<Parameters<typeof corsRefusal>[0][0]>) => ({
    origins: [ORIGIN],
    methods: ["PUT"],
    headers: ["content-type"],
    ...overrides,
  })

  it("allows a rule for this origin, PUT and the signed headers", () => {
    expect(corsRefusal([rule({})], ORIGIN, ["content-type"])).toBeNull()
    expect(
      corsRefusal([rule({ origins: ["*"], headers: ["*"] })], ORIGIN, [
        "content-type",
        "x-ms-blob-type",
      ])
    ).toBeNull()
  })

  it("matches one wildcard, and case, the way the services do", () => {
    expect(
      corsRefusal(
        [rule({ origins: ["https://*.example.org"], methods: ["put"] })],
        ORIGIN,
        ["Content-Type"]
      )
    ).toBeNull()
    expect(
      corsRefusal([rule({ headers: ["content-type", "x-ms-*"] })], ORIGIN, [
        "content-type",
        "x-ms-blob-type",
      ])
    ).toBeNull()
    expect(
      corsRefusal(
        [rule({ origins: ["https://*.example.org"] })],
        "https://example.org",
        ["content-type"]
      )
    ).toMatch(/origin https:\/\/example\.org/)
  })

  it("says what the closest rule is missing", () => {
    expect(corsRefusal([], ORIGIN, ["content-type"])).toMatch(/no CORS rules/)
    expect(
      corsRefusal([rule({ origins: ["http://localhost:3000"] })], ORIGIN, [
        "content-type",
      ])
    ).toBe(`No CORS rule allows the origin ${ORIGIN}.`)
    expect(
      corsRefusal([rule({ methods: ["GET", "HEAD"] })], ORIGIN, [
        "content-type",
      ])
    ).toBe(`The CORS rule for ${ORIGIN} does not allow PUT.`)
    expect(corsRefusal([rule({ headers: [] })], ORIGIN, ["content-type"])).toBe(
      `The CORS rule for ${ORIGIN} does not allow the headers content-type.`
    )
  })

  it("does not combine two rules into one that would allow it", () => {
    expect(
      corsRefusal(
        [
          rule({ methods: ["GET"] }),
          rule({ origins: ["https://other.example"] }),
        ],
        ORIGIN,
        ["content-type"]
      )
    ).not.toBeNull()
  })
})

describe("an S3 bucket's CORS rules", () => {
  const s3 = createS3Driver({
    bucket: "anonify",
    region: "us-east-1",
    accessKeyId: "a",
    secretAccessKey: "b",
    forcePathStyle: true,
    presignedUploads: true,
  })
  const failing = (name: string, status: number) => () => {
    throw Object.assign(new Error(name), {
      name,
      $metadata: { httpStatusCode: status },
    })
  }

  it("is allowed when a rule lets the browser PUT", async () => {
    sent.reply = () => ({
      CORSRules: [
        {
          AllowedOrigins: [ORIGIN],
          AllowedMethods: ["PUT", "GET"],
          AllowedHeaders: ["*"],
        },
      ],
    })
    await expect(s3.probeUploadCors!(ORIGIN)).resolves.toBe("allowed")
  })

  it("is refused when the bucket has no rules at all", async () => {
    sent.reply = failing("NoSuchCORSConfiguration", 404)
    await expect(s3.probeUploadCors!(ORIGIN)).rejects.toBeInstanceOf(
      CorsRefusal
    )
  })

  it("cannot be read without the API or the permission, and says so", async () => {
    sent.reply = failing("NotImplemented", 501)
    await expect(s3.probeUploadCors!(ORIGIN)).resolves.toBe("unreadable")
    sent.reply = failing("AccessDenied", 403)
    await expect(s3.probeUploadCors!(ORIGIN)).resolves.toBe("unreadable")
  })

  it("does not read Google Cloud Storage's rules, which are in its own format", async () => {
    const gcs = createS3Driver({
      bucket: "anonify",
      region: "auto",
      endpoint: "https://storage.googleapis.com",
      accessKeyId: "a",
      secretAccessKey: "b",
      forcePathStyle: true,
      presignedUploads: true,
    })
    sent.reply = () => ({})
    await expect(gcs.probeUploadCors!(ORIGIN)).resolves.toBe("unreadable")
  })

  it("passes on a bucket that did not answer", async () => {
    sent.reply = failing("TimeoutError", 0)
    const error = await s3.probeUploadCors!(ORIGIN).catch((e: unknown) => e)
    expect(error).not.toBeInstanceOf(CorsRefusal)
  })
})

// --- the page ---------------------------------------------------------------------

type Sent = {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

/**
 * XMLHttpRequest, answering each URL as told: a status and a body, or no
 * answer at all, which is what a CORS refusal looks like from the page.
 */
function fakeXhr(
  answer: (url: string) => { status: number; body: string } | "network-error"
) {
  const requests: Sent[] = []
  class FakeXhr {
    private listeners: Record<string, () => void> = {}
    private request: Sent = { method: "", url: "", headers: {}, body: null }
    status = 0
    responseText = ""
    upload = { addEventListener: () => {} }
    open(method: string, url: string) {
      this.request.method = method
      this.request.url = url
    }
    setRequestHeader(name: string, value: string) {
      this.request.headers[name.toLowerCase()] = value
    }
    addEventListener(name: string, listener: () => void) {
      this.listeners[name] = listener
    }
    send(body: unknown) {
      this.request.body = body
      requests.push(this.request)
      const result = answer(this.request.url)
      queueMicrotask(() => {
        if (result === "network-error") return this.listeners.error?.()
        this.status = result.status
        this.responseText = result.body
        this.listeners.load?.()
      })
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr)
  return requests
}

function presignAnswers() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        url: "https://bucket.example/doc?X-Amz-Signature=abc",
        headers: { "content-type": "application/octet-stream" },
        handle: "s3:documents/doc_1/upload/notes.txt",
      })
    )
  )
}

const ROUTE_ANSWER = {
  status: 201,
  body: JSON.stringify({ url: "s3:documents/doc_1/upload/notes.txt", size: 4 }),
}

describe("the page's upload paths (#185)", () => {
  it("PUTs the bytes alone through the app's route", async () => {
    const requests = fakeXhr(() => ROUTE_ANSWER)
    const body = new Blob(["seal"])
    await uploadThroughServer("doc_1", body, () => {})
    expect(requests).toEqual([
      {
        method: "PUT",
        url: "/api/upload/local?documentId=doc_1",
        headers: { "content-type": "application/octet-stream" },
        body,
      },
    ])
  })

  it("goes straight to the bucket when the bucket answers", async () => {
    presignAnswers()
    const requests = fakeXhr(() => ({ status: 200, body: "" }))
    const uploaded = await uploadStraightToStorage(
      "doc_1",
      new Blob(["seal"]),
      () => {}
    )
    expect(uploaded).toEqual({ url: "s3:documents/doc_1/upload/notes.txt" })
    expect(requests.map((r) => r.url)).toEqual([
      "https://bucket.example/doc?X-Amz-Signature=abc",
    ])
  })

  it("falls back to the app once, and says why, when the bucket gives no answer", async () => {
    presignAnswers()
    const requests = fakeXhr((url) =>
      url.startsWith("https://bucket.example") ? "network-error" : ROUTE_ANSWER
    )
    const uploaded = await uploadStraightToStorage(
      "doc_1",
      new Blob(["seal"]),
      () => {}
    )
    expect(uploaded).toMatchObject({
      url: "s3:documents/doc_1/upload/notes.txt",
    })
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({
      method: "PUT",
      url: "/api/upload/local?documentId=doc_1",
      headers: { "x-anonify-upload-fallback": "presigned-network-error" },
    })
  })

  it("does not fall back from a bucket that answered with a refusal", async () => {
    presignAnswers()
    const requests = fakeXhr(() => ({ status: 403, body: "<Error/>" }))
    await expect(
      uploadStraightToStorage("doc_1", new Blob(["seal"]), () => {})
    ).rejects.toThrow("Upload failed")
    expect(requests).toHaveLength(1)
  })
})
