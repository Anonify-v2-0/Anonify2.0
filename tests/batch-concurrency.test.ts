import { afterEach, describe, expect, it } from "vitest"

import {
  batchDefaultsFor,
  batchEnvName,
  batchLimits,
  BATCH_LIMIT_KEYS,
  InvalidBatchLimitError,
} from "@/lib/documents/batch-config"
import { MAX_BATCH_FILES } from "@/lib/config"
import { applyDocumentState } from "@/lib/documents/batch-exports"
import type { BatchExportDocument } from "@/lib/documents/batch-exports"

/**
 * How much of a batch happens at once.
 *
 * Two things are protected here, and the second is the one that made the first
 * possible. A batch export ran one document at a time because the progress row
 * is a single JSON column that every document rewrites, so two finishing
 * together would lose one of the results. The fix is a row lock, which cannot
 * be tested without a database — so what is tested here is the shape of the
 * clash it prevents, against the pure function both writers call.
 */

const KEYS = [...BATCH_LIMIT_KEYS]

afterEach(() => {
  for (const key of KEYS) delete process.env[batchEnvName(key)]
})

describe("batch limits", () => {
  it("rations a shared demo harder than somebody's own machine", () => {
    const demo = batchDefaultsFor("demo")
    const own = batchDefaultsFor("self-hosted")

    for (const key of KEYS) {
      expect(own[key]).toBeGreaterThan(demo[key])
    }
  })

  it("never defaults to unbounded concurrency", () => {
    // The bug this file exists to close: twenty uploads meant twenty
    // concurrent runs, because nothing had ever said otherwise.
    for (const profile of ["demo", "self-hosted"] as const) {
      const limits = batchDefaultsFor(profile)
      expect(limits.processing).toBeGreaterThan(0)
      expect(limits.exporting).toBeGreaterThan(0)
      expect(Number.isFinite(limits.processing)).toBe(true)
    }
  })

  it("keeps the compiled default in step with the demo profile", () => {
    // A client bundle cannot read a server environment variable, so the upload
    // panel slices with the constant until /api/limits answers. If the two
    // disagree the panel drops files the server would have taken.
    expect(MAX_BATCH_FILES).toBe(batchDefaultsFor("demo").maxFiles)
  })

  it("takes an override from the environment", () => {
    process.env[batchEnvName("processing")] = "8"
    expect(batchLimits("demo").processing).toBe(8)
    // The others keep the profile's value: setting one must not require
    // restating the rest.
    expect(batchLimits("demo").exporting).toBe(
      batchDefaultsFor("demo").exporting
    )
  })

  it("refuses a malformed override rather than ignoring it", () => {
    // A limit somebody believes they set and which is not in force is worse
    // than no setting at all.
    for (const raw of ["nonsense", "0", "-1", "2.5", "9999"]) {
      process.env[batchEnvName("processing")] = raw
      expect(() => batchLimits("demo")).toThrow(InvalidBatchLimitError)
    }
  })

  it("will not let concurrency be turned off by setting it to zero", () => {
    process.env[batchEnvName("exporting")] = "0"
    expect(() => batchLimits("demo")).toThrow(InvalidBatchLimitError)
  })
})

describe("recording two documents that finish together", () => {
  const documents: BatchExportDocument[] = [
    { id: "doc_1", name: "one.pdf", state: "exporting" },
    { id: "doc_2", name: "two.pdf", state: "exporting" },
    { id: "doc_3", name: "three.pdf", state: "pending" },
  ]

  it("keeps both results when the writes are applied in turn", () => {
    // What the row lock buys: the second writer reads what the first wrote.
    const first = applyDocumentState(documents, "doc_1", {
      state: "exported",
      removed: 3,
    })
    const second = applyDocumentState(first.documents, "doc_2", {
      state: "exported",
      removed: 5,
    })

    expect(second.exported).toBe(2)
    expect(second.completed).toBe(2)
    expect(
      second.documents.filter((document) => document.state === "exported")
    ).toHaveLength(2)
  })

  it("shows what is lost when they are not", () => {
    // Both writers read the same list, and the later write wins outright. This
    // is the failure `patchDocumentState` takes a row lock to prevent, and it
    // is silent: doc_1 sits at "exporting" on a run that finished with it.
    const fromOne = applyDocumentState(documents, "doc_1", { state: "exported" })
    const fromTwo = applyDocumentState(documents, "doc_2", { state: "exported" })

    expect(fromTwo.exported).toBe(1)
    expect(
      fromTwo.documents.find((document) => document.id === "doc_1")?.state
    ).toBe("exporting")
    // And the earlier write is simply gone.
    expect(fromOne.documents).not.toEqual(fromTwo.documents)
  })

  it("counts from the states rather than incrementing, so a replay is safe", () => {
    // A retried step re-records the same outcome. The totals are a function of
    // the list, so recording it twice cannot count it twice.
    const once = applyDocumentState(documents, "doc_1", { state: "exported" })
    const twice = applyDocumentState(once.documents, "doc_1", {
      state: "exported",
    })

    expect(twice.exported).toBe(once.exported)
    expect(twice.completed).toBe(once.completed)
  })
})
