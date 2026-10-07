import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { cacheDirectory, modelDirectory } from "@/lib/ocr/tesseract"

/**
 * The OCR model the container image carries (#178).
 *
 * A replica reads the baked model in place when it holds everything that is
 * configured, so a cluster with no outbound internet, or a read-only root
 * filesystem, still reads scans. What it must never do is read a model of the
 * wrong variant from it.
 */

let root: string
let baked: string
let cache: string

function bake(relative: string, content = "model") {
  const file = path.join(baked, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "anonify-ocr-"))
  baked = path.join(root, "baked")
  cache = path.join(root, "cache")
  mkdirSync(baked)
  vi.stubEnv("TESSERACT_BAKED_PATH", baked)
  vi.stubEnv("TESSERACT_CACHE_PATH", cache)
  vi.stubEnv("OCR_TESSERACT_MODEL", "")
  vi.stubEnv("OCR_TESSERACT_LANGUAGE", "")
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe("modelDirectory", () => {
  it("reads the baked model in place when it holds the configured language", async () => {
    bake("eng.traineddata")
    expect(await modelDirectory()).toBe(baked)
    // Nothing was written anywhere: a read-only filesystem is fine.
    expect(existsSync(cache)).toBe(false)
  })

  it("uses the cache when nothing is baked, or no baked path is set", async () => {
    expect(await modelDirectory()).toBe(cacheDirectory())

    vi.stubEnv("TESSERACT_BAKED_PATH", "")
    bake("eng.traineddata")
    expect(await modelDirectory()).toBe(cache)
  })

  it("never reads another variant's model from the baked directory", async () => {
    bake("eng.traineddata")
    vi.stubEnv("OCR_TESSERACT_MODEL", "best")

    const directory = await modelDirectory()

    expect(directory).toBe(path.join(cache, "best"))
    expect(existsSync(path.join(directory, "eng.traineddata"))).toBe(false)
  })

  it("reads a baked non-default variant from its own directory", async () => {
    bake(path.join("best", "eng.traineddata"))
    vi.stubEnv("OCR_TESSERACT_MODEL", "best")
    expect(await modelDirectory()).toBe(path.join(baked, "best"))
  })

  it("copies the baked languages into the cache when more are configured", async () => {
    bake("eng.traineddata", "english")
    vi.stubEnv("OCR_TESSERACT_LANGUAGE", "eng+deu")

    const directory = await modelDirectory()

    expect(directory).toBe(cache)
    expect(readFileSync(path.join(cache, "eng.traineddata"), "utf8")).toBe(
      "english"
    )
    expect(existsSync(path.join(cache, "deu.traineddata"))).toBe(false)
  })

  it("leaves a model already in the cache alone", async () => {
    bake("eng.traineddata", "baked")
    mkdirSync(cache, { recursive: true })
    writeFileSync(path.join(cache, "eng.traineddata"), "downloaded")
    vi.stubEnv("OCR_TESSERACT_LANGUAGE", "eng+fra")

    await modelDirectory()

    expect(readFileSync(path.join(cache, "eng.traineddata"), "utf8")).toBe(
      "downloaded"
    )
  })
})
