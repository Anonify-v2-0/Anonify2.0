import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  pack,
  readArchive,
  tar,
  unpack,
  untar,
} from "@/benchmarks/corpus/lib/archive"
import type { LabelledDocument } from "@/benchmarks/corpus/lib/types"
import {
  agreement,
  aggregate,
  bootstrap,
  covers,
  MISS_WEIGHTS,
  scoreDocument,
} from "@/benchmarks/lib/scoring"

const TEXT = "Call Priya Raman on 555-0142 about INV-2291."
const DOCUMENT = {
  id: "syn-v1-0001",
  docType: "email thread",
  text: TEXT,
  spans: [
    { start: 5, end: 16, category: "person", value: "Priya Raman" },
    { start: 20, end: 28, category: "phone", value: "555-0142" },
  ],
  negatives: [{ start: 35, end: 43, value: "INV-2291" }],
} as unknown as LabelledDocument

describe("corpus scoring", () => {
  it("counts a value covered only when every character is, spaces aside", () => {
    const name = { start: 5, end: 16 }
    expect(covers(TEXT, name, [{ start: 5, end: 16 }])).toBe(true)
    // "Priya" and "Raman" separately: the space between them is not a leak.
    expect(
      covers(TEXT, name, [
        { start: 5, end: 10 },
        { start: 11, end: 16 },
      ])
    ).toBe(true)
    // "Priya" alone leaves the surname readable.
    expect(covers(TEXT, name, [{ start: 5, end: 10 }])).toBe(false)
    expect(covers(TEXT, name, [{ start: 3, end: 30 }])).toBe(true)
  })

  it("tells covered, overlapping and category-strict recall apart", () => {
    const score = scoreDocument(DOCUMENT, [
      { start: 5, end: 10, category: "person" },
      { start: 20, end: 28, category: "customer-id" },
    ])
    expect(score.labels).toEqual([
      { category: "person", covered: false, overlap: true, strict: false },
      { category: "phone", covered: true, overlap: true, strict: false },
    ])
  })

  it("prices a missed value by its category and a false positive at one", () => {
    const quality = aggregate([
      scoreDocument(DOCUMENT, [
        { start: 20, end: 28, category: "phone" },
        { start: 35, end: 43, category: "customer-id" },
      ]),
    ])
    expect(quality.recall).toBe(0.5)
    expect(quality.precision).toBe(0.5)
    expect(quality.falsePositives).toBe(1)
    expect(quality.negativeHits).toBe(1)
    expect(quality.weightedCost.total).toBe(MISS_WEIGHTS.person + 1)
    expect(quality.weightedCost.missed).toEqual({ person: 1 })
  })

  it("folds a detection inside another before counting precision (#205)", () => {
    const score = scoreDocument(DOCUMENT, [
      { start: 5, end: 16, category: "person" },
      // "Raman" inside "Priya Raman": one region for a reviewer, not two.
      { start: 11, end: 16, category: "person" },
      { start: 35, end: 43, category: "customer-id" },
    ])
    expect(score.merged).toBe(1)
    expect(score.detections).toHaveLength(2)
    const quality = aggregate([score])
    expect(quality.precision).toBe(0.5)
    expect(quality.merged).toBe(1)
    // Recall still reads every detection.
    expect(quality.recall).toBe(0.5)
  })

  it("counts a value once per document in distinct precision", () => {
    const text = "INV-2291 and INV-2291 again, then Priya Raman."
    const document = {
      ...DOCUMENT,
      text,
      spans: [{ start: 34, end: 45, category: "person", value: "Priya Raman" }],
      negatives: [],
    } as unknown as LabelledDocument
    const quality = aggregate([
      scoreDocument(document, [
        { start: 0, end: 8, category: "customer-id" },
        { start: 13, end: 21, category: "customer-id" },
        { start: 34, end: 45, category: "person" },
      ]),
    ])
    expect(quality.precision).toBe(0.3333)
    expect(quality.distinct).toEqual({ detections: 2, precision: 0.5 })
  })

  it("reports precision and recall at confidence cut-offs, when it was recorded", () => {
    const quality = aggregate([
      scoreDocument(DOCUMENT, [
        { start: 5, end: 16, category: "person", confidence: 0.95 },
        { start: 20, end: 28, category: "phone", confidence: 0.6 },
        { start: 35, end: 43, category: "customer-id", confidence: 0.75 },
      ]),
    ])
    expect(quality.byConfidence).toEqual([
      { cutoff: 0.5, detections: 3, precision: 0.6667, recall: 1 },
      { cutoff: 0.7, detections: 2, precision: 0.5, recall: 0.5 },
      { cutoff: 0.8, detections: 1, precision: 1, recall: 0.5 },
      { cutoff: 0.9, detections: 1, precision: 1, recall: 0.5 },
    ])
    expect(
      aggregate([
        scoreDocument(DOCUMENT, [{ start: 5, end: 16, category: "person" }]),
      ]).byConfidence
    ).toBeNull()
  })

  it("bootstraps an interval over documents, the same each time", () => {
    const right = scoreDocument(DOCUMENT, [
      { start: 5, end: 16, category: "person" },
      { start: 20, end: 28, category: "phone" },
    ])
    const wrong = scoreDocument(DOCUMENT, [
      { start: 35, end: 43, category: "customer-id" },
    ])
    const scores = [right, right, wrong, right]
    const interval = bootstrap(scores, 500)
    expect(interval).toEqual(bootstrap(scores, 500))
    expect(interval!.precision![0]).toBeLessThan(interval!.precision![1])
    expect(interval!.precision![1]).toBeLessThanOrEqual(1)
    expect(bootstrap([right])).toBeNull()
    expect(aggregate(scores, { interval: true }).interval).toEqual(
      bootstrap(scores)
    )
    expect(aggregate(scores).interval).toBeUndefined()
  })

  it("measures agreement between two runs on the same labels", () => {
    const both = [{ start: 5, end: 28, category: "person" }]
    const same = agreement(
      [DOCUMENT],
      { [DOCUMENT.id]: both },
      { [DOCUMENT.id]: both }
    )
    expect(same.observed).toBe(1)
    expect(same.redactedJaccard).toBe(1)

    const different = agreement(
      [DOCUMENT],
      { [DOCUMENT.id]: [{ start: 5, end: 16, category: "person" }] },
      { [DOCUMENT.id]: [{ start: 20, end: 28, category: "phone" }] }
    )
    expect(different.onlyFirst).toBe(1)
    expect(different.onlySecond).toBe(1)
    expect(different.redactedJaccard).toBe(0)
  })
})

describe("corpus archive", () => {
  let dir: string
  let root: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "corpus-archive-"))
    root = path.join(dir, "synthetic-test")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const put = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true })
    await writeFile(path.join(root, file), content)
  }
  const read = (file: string) =>
    readFile(path.join(root, file), "utf8").catch(() => null)

  it("round-trips files through a tarball", () => {
    const files = new Map([
      ["dev/a.json", Buffer.from("{}\n")],
      ["test/b.json", Buffer.alloc(1000, 120)],
    ])
    expect(untar("synthetic-test", tar("synthetic-test", files))).toEqual(files)
  })

  it("refuses an entry that climbs out of the corpus", () => {
    const evil = tar("synthetic-test", new Map([["../../x", Buffer.from("x")]]))
    expect(() => untar("synthetic-test", evil)).toThrow(/outside/)
  })

  it("packs only when something changed, and leaves the manifest out", async () => {
    await put("dev/a.json", "1")
    await put("manifest.json", "{}")
    expect((await pack(root)).changed).toBe(true)
    expect((await pack(root)).changed).toBe(false)
    expect([...(await readArchive(root))!.keys()]).toEqual(["dev/a.json"])
  })

  it("merges the archive into a working copy without losing local work", async () => {
    await put("dev/same.json", "base")
    await put("dev/theirs.json", "base")
    await put("dev/mine.json", "base")
    await put("dev/both.json", "base")
    await put("dev/deleted.json", "base")
    await pack(root)

    // Someone else's archive: two files changed and one added.
    const upstream = new Map([
      ["dev/both.json", Buffer.from("theirs")],
      ["dev/deleted.json", Buffer.from("base")],
      ["dev/mine.json", Buffer.from("base")],
      ["dev/new.json", Buffer.from("new")],
      ["dev/same.json", Buffer.from("base")],
      ["dev/theirs.json", Buffer.from("theirs")],
    ])
    // Local work since the last pack.
    await put("dev/mine.json", "mine")
    await put("dev/both.json", "mine")
    await rm(path.join(root, "dev/deleted.json"))
    await writeFile(`${root}.tar.gz`, gzipSync(tar("synthetic-test", upstream)))

    const result = await unpack(root)
    expect(await read("dev/theirs.json")).toBe("theirs")
    expect(await read("dev/new.json")).toBe("new")
    expect(await read("dev/mine.json")).toBe("mine")
    expect(await read("dev/both.json")).toBe("mine")
    expect(await read("dev/deleted.json")).toBeNull()
    expect(result.conflicts).toEqual(["dev/both.json"])
  })

  it("unpacks everything into an empty working copy, and --force resets it", async () => {
    await put("dev/a.json", "archived")
    await pack(root)
    await rm(path.join(root, "dev"), { recursive: true })
    expect((await unpack(root)).written).toEqual(["dev/a.json"])

    await put("dev/a.json", "edited")
    await put("dev/extra.json", "extra")
    await unpack(root, { force: true })
    expect(await read("dev/a.json")).toBe("archived")
    expect(await read("dev/extra.json")).toBeNull()
  })
})
