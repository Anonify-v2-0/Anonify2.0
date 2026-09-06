import { afterEach, describe, expect, it, vi } from "vitest"

import {
  InvalidOcrModelError,
  mistralOcrModel,
  tesseractLangPath,
  tesseractLanguage,
  tesseractLanguageCodes,
  tesseractModel,
  TESSERACT_LANGUAGES,
  TESSERACT_MODEL_DETAIL,
  TESSERACT_MODELS,
} from "@/lib/ocr/models"
import {
  dailySpendCapUsd,
  InvalidServiceLimitError,
  InvalidSpendCapError,
  serviceDefaults,
  serviceEnvName,
  serviceLimits,
  SERVICE_LIMIT_KEYS,
  SERVICES,
  SPEND_ENV_NAME,
} from "@/lib/services/limits"
import {
  backoffMs,
  classifyServiceError,
  resetThrottles,
  retryAfterMs,
  runThrottled,
  setConcurrencyCeiling,
  throttleState,
} from "@/lib/services/throttle"

/**
 * Pacing the services that are not ours.
 *
 * Two failures are being prevented and they are the same failure in different
 * clothes: work the user asked for, silently not done. An OCR page that dies on
 * a 429 leaves a document whose last pages were never read; a contextual pass
 * that returns nothing on the same 429 leaves a document reviewed against
 * pattern matching alone. Both come out looking finished, which is why the
 * retrying, the pacing and the reporting all matter here.
 */

const ENV_KEYS = [
  ...SERVICES.flatMap((service) =>
    SERVICE_LIMIT_KEYS.map((key) => serviceEnvName(service, key))
  ),
  SPEND_ENV_NAME,
  "OCR_TESSERACT_MODEL",
  "OCR_TESSERACT_LANGUAGE",
  "MISTRAL_OCR_MODEL",
]

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  resetThrottles()
  vi.restoreAllMocks()
})

/** An error shaped like the ones the AI and Mistral SDKs actually throw. */
function httpError(
  status: number,
  headers: Record<string, string> = {}
): Error & { statusCode: number } {
  const error = new Error(`Request failed with status ${status}`) as Error & {
    statusCode: number
    responseHeaders: Record<string, string>
  }
  error.statusCode = status
  error.responseHeaders = headers
  return error
}

describe("service limit configuration", () => {
  it("is not per-profile, because an account's ceiling is not either", () => {
    // Every other limit file in this codebase splits by profile. These do not,
    // and the test exists so that stays a decision rather than an oversight.
    expect(serviceDefaults("ai").concurrency).toBe(4)
    expect(serviceDefaults("ocr").requestsPerMinute).toBe(60)
  })

  it("names its variables the way every other limit does", () => {
    expect(serviceEnvName("ai", "concurrency")).toBe("ANONIFY_AI_CONCURRENCY")
    expect(serviceEnvName("ocr", "requestsPerMinute")).toBe(
      "ANONIFY_OCR_REQUESTS_PER_MINUTE"
    )
    expect(serviceEnvName("ocr", "maxAttempts")).toBe("ANONIFY_OCR_MAX_ATTEMPTS")
  })

  it("takes an override", () => {
    process.env.ANONIFY_OCR_CONCURRENCY = "8"
    expect(serviceLimits("ocr").concurrency).toBe(8)
    // Untouched keys keep their defaults, so raising one does not require
    // restating the rest.
    expect(serviceLimits("ocr").maxAttempts).toBe(4)
  })

  it("accepts a rate of zero, which means do not pace", () => {
    process.env.ANONIFY_OCR_REQUESTS_PER_MINUTE = "0"
    expect(serviceLimits("ocr").requestsPerMinute).toBe(0)
  })

  it("refuses a concurrency of zero, which would stop the service", () => {
    process.env.ANONIFY_AI_CONCURRENCY = "0"
    expect(() => serviceLimits("ai")).toThrow(InvalidServiceLimitError)
  })

  it("throws on a malformed override rather than ignoring it", () => {
    // A limit somebody believes they set and which is not in force is worse
    // than no setting at all.
    process.env.ANONIFY_AI_MAX_ATTEMPTS = "lots"
    expect(() => serviceLimits("ai")).toThrow(/ANONIFY_AI_MAX_ATTEMPTS/)

    process.env.ANONIFY_AI_MAX_ATTEMPTS = "500"
    expect(() => serviceLimits("ai")).toThrow(/between 1 and 10/)
  })
})

describe("the daily spend cap", () => {
  it("is off unless somebody sets it", () => {
    expect(dailySpendCapUsd()).toBe(0)
  })

  it("takes an amount that is not a whole number of dollars", () => {
    process.env[SPEND_ENV_NAME] = "2.50"
    expect(dailySpendCapUsd()).toBe(2.5)
  })

  it("refuses a negative budget", () => {
    process.env[SPEND_ENV_NAME] = "-5"
    expect(() => dailySpendCapUsd()).toThrow(InvalidSpendCapError)
  })
})

describe("classifying a provider failure", () => {
  it("retries a rate limit and honours what the response asked for", () => {
    const failure = classifyServiceError(httpError(429, { "retry-after": "12" }))
    expect(failure.kind).toBe("rate-limit")
    expect(failure.retryable).toBe(true)
    expect(failure.retryAfterMs).toBe(12_000)
  })

  it("does not retry an empty balance", () => {
    // Retrying a 402 spends money the account does not have, and where the
    // balance tops up automatically it spends money it does.
    const failure = classifyServiceError(httpError(402))
    expect(failure.kind).toBe("budget")
    expect(failure.retryable).toBe(false)
  })

  it("does not retry a bad key", () => {
    expect(classifyServiceError(httpError(401)).retryable).toBe(false)
    expect(classifyServiceError(httpError(403)).retryable).toBe(false)
  })

  it("retries the provider's own failures", () => {
    expect(classifyServiceError(httpError(503)).retryable).toBe(true)
    expect(classifyServiceError(httpError(408)).retryable).toBe(true)
  })

  it("does not retry a request it got wrong", () => {
    const failure = classifyServiceError(httpError(422))
    expect(failure.retryable).toBe(false)
  })

  it("falls back to the message when there is no status", () => {
    expect(classifyServiceError(new Error("429 Too Many Requests")).kind).toBe(
      "rate-limit"
    )
    expect(classifyServiceError(new Error("socket hang up")).kind).toBe("timeout")
    expect(
      classifyServiceError(new Error("invalid api key")).retryable
    ).toBe(false)
  })

  it("reads a Retry-After given as a date", () => {
    const at = new Date(Date.now() + 30_000).toUTCString()
    const ms = retryAfterMs(httpError(429, { "retry-after": at }))
    expect(ms).toBeGreaterThan(25_000)
    expect(ms).toBeLessThanOrEqual(30_000)
  })

  it("reads headers from a Headers instance too", () => {
    const error = new Error("rate limited") as Error & {
      rawResponse: { headers: Headers }
    }
    error.rawResponse = { headers: new Headers({ "retry-after": "3" }) }
    expect(retryAfterMs(error)).toBe(3_000)
  })
})

describe("backoff", () => {
  it("doubles, caps, and never returns the same wait twice in a row", () => {
    // The jitter is the point. Four callers refused together and told to wait
    // the same interval arrive back together, and the second burst is the first
    // one — which against a rate limit is the response that makes it worse.
    expect(backoffMs(1, () => 0)).toBe(500)
    expect(backoffMs(1, () => 1)).toBe(1000)
    expect(backoffMs(3, () => 0)).toBe(2000)
    expect(backoffMs(50, () => 1)).toBe(30_000)
  })
})

describe("running through the gate", () => {
  it("returns the value when nothing goes wrong", async () => {
    const result = await runThrottled("ai", { label: "test" }, async () => "ok")
    expect(result).toBe("ok")
    // The slot is given back, or the second document never runs.
    expect(throttleState("ai").active).toBe(0)
  })

  it("retries a rate limit and succeeds on the next attempt", async () => {
    let calls = 0
    const result = await runThrottled(
      "ai",
      { label: "test", maxAttempts: 3 },
      async () => {
        calls += 1
        if (calls === 1) throw httpError(429, { "retry-after": "0" })
        return "second time"
      }
    )

    expect(result).toBe("second time")
    expect(calls).toBe(2)
  })

  it("gives up on a bad key without a second attempt", async () => {
    let calls = 0
    await expect(
      runThrottled("ai", { label: "test", maxAttempts: 5 }, async () => {
        calls += 1
        throw httpError(401)
      })
    ).rejects.toThrow()

    expect(calls).toBe(1)
  })

  it("rethrows the last failure once the attempts are spent", async () => {
    const waits: number[] = []
    await expect(
      runThrottled(
        "ai",
        {
          label: "test",
          maxAttempts: 3,
          onRetry: ({ waitMs }) => waits.push(waitMs),
        },
        async () => {
          throw httpError(429, { "retry-after": "0" })
        }
      )
    ).rejects.toThrow(/429/)

    // Two waits for three attempts: the last failure is thrown, not slept on.
    expect(waits).toEqual([0, 0])
  })

  it("holds concurrent callers to the configured ceiling", async () => {
    process.env.ANONIFY_AI_CONCURRENCY = "2"

    let peak = 0
    let inFlight = 0
    const release: (() => void)[] = []

    const runs = Array.from({ length: 5 }, () =>
      runThrottled("ai", { label: "test" }, async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise<void>((resolve) => release.push(resolve))
        inFlight -= 1
        return null
      })
    )

    // Let the first wave start, then let everything through.
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(peak).toBe(2)

    while (release.length > 0 || inFlight > 0) {
      release.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
    await Promise.all(runs)

    expect(peak).toBe(2)
    expect(throttleState("ai").active).toBe(0)
  })

  it("lets the spend cap lower the ceiling, and never raise it", async () => {
    process.env.ANONIFY_AI_CONCURRENCY = "3"

    const peakWith = async (ceiling: number | null) => {
      setConcurrencyCeiling("ai", ceiling)

      let peak = 0
      let inFlight = 0
      const release: (() => void)[] = []

      const runs = Array.from({ length: 4 }, () =>
        runThrottled("ai", { label: "test" }, async () => {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise<void>((resolve) => release.push(resolve))
          inFlight -= 1
          return null
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 5))
      while (release.length > 0 || inFlight > 0) {
        release.shift()?.()
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      await Promise.all(runs)
      return peak
    }

    // Approaching the day's budget: one call at a time, so the run finishes
    // rather than arriving at the wall three abreast.
    expect(await peakWith(1)).toBe(1)

    // Asked for more than is configured, the configured number still wins.
    expect(await peakWith(99)).toBe(3)

    setConcurrencyCeiling("ai", null)
    expect(throttleState("ai").ceiling).toBeNull()
  })

  it("paces a burst rather than refusing it", async () => {
    // 60 a minute is one a second with a burst of one, so the second request
    // waits instead of being refused — which is the whole difference between
    // this and the inbound rate limiter.
    process.env.ANONIFY_OCR_REQUESTS_PER_MINUTE = "60"
    process.env.ANONIFY_OCR_CONCURRENCY = "4"

    const started = Date.now()
    await Promise.all([
      runThrottled("ocr", { label: "one" }, async () => null),
      runThrottled("ocr", { label: "two" }, async () => null),
    ])

    // Both completed — nothing was lost — and the second one waited for it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  }, 10_000)
})

describe("OCR model selection", () => {
  it("defaults to the variant tesseract.js ships with", () => {
    expect(tesseractModel()).toBe("standard")
    // Null means "leave langPath unset", so the library's own default is not
    // pinned here and cannot drift from it.
    expect(tesseractLangPath()).toBeNull()
  })

  it("maps a chosen variant to a real data path", () => {
    process.env.OCR_TESSERACT_MODEL = "best"
    expect(tesseractLangPath()).toBe("https://tessdata.projectnaptha.com/4.0.0_best")

    process.env.OCR_TESSERACT_MODEL = "fast"
    expect(tesseractLangPath()).toBe("https://tessdata.projectnaptha.com/4.0.0_fast")
  })

  it("refuses a variant that is not on the list", () => {
    // The point of the list: a typo here is a re-prompt in setup, not a 404
    // from a CDN on the first scanned page of a container that started fine.
    process.env.OCR_TESSERACT_MODEL = "biggest"
    expect(() => tesseractModel()).toThrow(InvalidOcrModelError)
    expect(() => tesseractModel()).toThrow(/fast, standard, best/)
  })

  it("takes several languages, validating each one", () => {
    process.env.OCR_TESSERACT_LANGUAGE = "eng+deu"
    expect(tesseractLanguage()).toBe("eng+deu")
    expect(tesseractLanguageCodes()).toEqual(["eng", "deu"])

    process.env.OCR_TESSERACT_LANGUAGE = "eng+klingon"
    expect(() => tesseractLanguage()).toThrow(/klingon/)
  })

  it("describes every variant it offers", () => {
    for (const model of TESSERACT_MODELS) {
      expect(TESSERACT_MODEL_DETAIL[model].summary).toBeTruthy()
      expect(TESSERACT_MODEL_DETAIL[model].approxMb).toBeGreaterThan(0)
    }
    expect(TESSERACT_LANGUAGES).toContain("eng")
  })

  it("validates the Mistral model too", () => {
    expect(mistralOcrModel()).toBe("mistral-ocr-latest")

    process.env.MISTRAL_OCR_MODEL = "mistral-ocr-2505"
    expect(mistralOcrModel()).toBe("mistral-ocr-2505")

    process.env.MISTRAL_OCR_MODEL = "mistral-ocr-9999"
    expect(() => mistralOcrModel()).toThrow(InvalidOcrModelError)
  })
})
