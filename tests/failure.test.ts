import { describe, expect, it } from "vitest"

import {
  describeFailure,
  failureForCode,
  isRetryable,
  FAILURE_CODES,
} from "@/lib/workflows/failure"
import { quotaMessage } from "@/lib/security/usage"
import { isReviewable } from "@/types/document"

/**
 * A processing failure is the one moment the product has to explain itself, and
 * it used to do it in the runtime's words: the screen said
 * `FatalError: Unsupported file type`, and any error at all could put its own
 * internal message there.
 *
 * Two things are being held down here. That what the user reads is written for
 * them, and that the raw message never survives the trip — a driver or parser
 * error is not guaranteed to be free of document content, so this is the same
 * rule invariant 6 applies to logging.
 */

describe("classifying a processing failure", () => {
  it("strips the runtime's class name from what the user reads", () => {
    const failure = describeFailure(
      new Error("FatalError: Unsupported file type")
    )

    expect(failure.code).toBe("unsupported-type")
    expect(failure.message).not.toContain("FatalError")
    expect(failure.message).toMatch(/not in a format Anonify can read/i)
  })

  it("peels the wrapper a step adds when it exhausts its retries", () => {
    const failure = describeFailure(
      new Error(
        'Step "extractAndNormalize" failed after 4 retries: ECONNREFUSED 127.0.0.1:5432'
      )
    )

    expect(failure.code).toBe("database")
    expect(failure.retryable).toBe(true)
  })

  it.each([
    ["Unsupported file type", "unsupported-type"],
    ["File contents do not match its extension", "extension-mismatch"],
    ["Uploaded file is empty", "empty-file"],
    ["Uploaded file is too large", "too-large"],
    ["Source checksum mismatch", "corrupt-source"],
    ["No upload to ingest", "missing-upload"],
    ["Document has not been normalized", "internal-state"],
    ["No extractor registered for pptx", "unsupported-type"],
  ])("reads %j as %s", (message, code) => {
    expect(describeFailure(new Error(`FatalError: ${message}`)).code).toBe(code)
  })

  it("recognises the quota message the pipeline actually throws", () => {
    // Built from the real producer rather than a copy of its wording, so
    // rephrasing the quota message cannot silently stop it being classified.
    const raw = quotaMessage({
      allowed: false,
      kind: "xlsxCells",
      limit: 10_000,
      used: 10_000,
      remaining: 0,
    })

    const failure = describeFailure(new Error(`FatalError: ${raw}`))

    expect(failure.code).toBe("quota")
    // Retrying now spends a rate-limit token to fail the same way; the message
    // has to point at what does help instead.
    expect(failure.retryable).toBe(false)
    expect(failure.message).toMatch(/midnight UTC/i)
  })

  it("does not mistake an exhausted retry for a verdict", () => {
    /*
     * Taken verbatim from a failed row in a real database. The runtime re-throws
     * a step that has run out of retries as a `FatalError` — nothing is left to
     * try, from its side — so the class name appears on a cause that was
     * transient enough to be attempted three times.
     *
     * Reading that as final is the expensive mistake: it removes the retry
     * button from the one category of failure where pressing it can work.
     */
    const raw =
      'FatalError: Step "step//./lib/workflows/process-document//extractAndNormalize" ' +
      'failed after 3 retries: Setting up fake worker failed: "Cannot find module ' +
      "'E:\\Anonify2.0\\[externals]\\pdfjs-dist\\package.json'\"."

    const failure = describeFailure(new Error(raw))

    expect(failure.retryable).toBe(true)
    expect(failure.code).not.toBe("internal-state")
    expect(failure.message).not.toContain("pdfjs-dist")
    expect(failure.message).not.toContain("E:\\Anonify2.0")
  })

  it("peels the wrappers in either order", () => {
    const inner = "Uploaded file is empty"

    expect(describeFailure(new Error(`FatalError: ${inner}`)).code).toBe(
      "empty-file"
    )
    expect(
      describeFailure(new Error(`Step "ingestUpload" failed after 3 retries: ${inner}`))
        .code
    ).toBe("empty-file")
    expect(
      describeFailure(
        new Error(`FatalError: Step "ingestUpload" failed after 3 retries: ${inner}`)
      ).code
    ).toBe("empty-file")
  })

  it("treats an unrecognised FatalError as final, not as weather", () => {
    // The pipeline only throws FatalError where it has decided retrying is
    // pointless. Honouring that beats the generic default, which assumes it is.
    const failure = describeFailure(new Error("FatalError: something new"))

    expect(failure.retryable).toBe(false)
    expect(failure.code).toBe("internal-state")
  })

  it("treats an unrecognised ordinary error as worth another attempt", () => {
    const failure = describeFailure(new Error("socket hang up"))

    expect(failure.code).toBe("unknown")
    expect(failure.retryable).toBe(true)
  })

  it("accepts a bare string, which is how the orchestrator passes it on", () => {
    expect(describeFailure("FatalError: Uploaded file is empty").code).toBe(
      "empty-file"
    )
  })

  it("never lets the thrown text through, whatever it carried", () => {
    // The failure this guards: an error whose message quotes the document, or
    // names a secret, going straight into a database column and onto a screen.
    const leaky = new Error(
      'Error: parse failed near "Jane Doe, 123 Main St, SSN 123-45-6789"'
    )

    const failure = describeFailure(leaky)

    expect(failure.message).not.toContain("Jane Doe")
    expect(failure.message).not.toContain("123-45-6789")
    expect(failure.message).toBe(failureForCode(failure.code).message)
  })

  it("does not echo a configuration value it was handed", () => {
    const failure = describeFailure(
      new Error(
        "ENCRYPTION_KEY must decode to 32 bytes (64 hex chars or base64)"
      )
    )

    expect(failure.code).toBe("configuration")
    expect(failure.message).not.toContain("ENCRYPTION_KEY")
    // An administrator has to change something; a retry loop cannot fix it.
    expect(failure.retryable).toBe(false)
  })

  it("gives every code a message of its own", () => {
    const messages = FAILURE_CODES.map((code) => failureForCode(code).message)
    expect(new Set(messages).size).toBe(FAILURE_CODES.length)
  })
})

describe("deciding whether to offer a retry", () => {
  it("offers one for a failure that could go differently", () => {
    expect(isRetryable("storage")).toBe(true)
    expect(isRetryable("timeout")).toBe(true)
    expect(isRetryable("unknown")).toBe(true)
  })

  it("refuses one for a verdict", () => {
    expect(isRetryable("unsupported-type")).toBe(false)
    expect(isRetryable("extension-mismatch")).toBe(false)
    expect(isRetryable("quota")).toBe(false)
    expect(isRetryable("configuration")).toBe(false)
  })

  it("still offers one for a document that failed before codes existed", () => {
    // Rows written by the old pipeline have no code. The old behaviour is what
    // the user already expects, and a retry is cheap.
    expect(isRetryable(null)).toBe(true)
    expect(isRetryable(undefined)).toBe(true)
  })

  it("falls back rather than trusting a code it does not know", () => {
    expect(failureForCode("invented-by-a-newer-deploy").code).toBe("unknown")
  })
})

describe("deciding whether to open the editor", () => {
  it("opens for a ready document", () => {
    expect(isReviewable({ status: "ready", reviewable: false })).toBe(true)
  })

  it("opens for a failure that happened after extraction", () => {
    // There is a normalized model behind it, so the text is real and can be
    // redacted by hand even though analysis never finished.
    expect(isReviewable({ status: "failed", reviewable: true })).toBe(true)
  })

  it("does not open over nothing", () => {
    // The bug this replaces: every failure took the editor branch, so a
    // document that died during ingest sat under "Preparing this document…"
    // with no reason given and the retry button unreachable.
    expect(isReviewable({ status: "failed", reviewable: false })).toBe(false)
    expect(isReviewable({ status: "failed", reviewable: undefined })).toBe(false)
  })

  it("does not open while the run is still going", () => {
    expect(isReviewable({ status: "analyzing", reviewable: true })).toBe(false)
    expect(isReviewable({ status: "queued", reviewable: false })).toBe(false)
  })
})
