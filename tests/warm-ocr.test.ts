import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, expect, it, vi } from "vitest"

import {
  closeTesseractPools,
  tesseractPoolState,
} from "@/lib/ocr/tesseract-pool"

const worker = vi.hoisted(() => ({
  recognize: vi.fn(),
  terminate: vi.fn(),
}))

vi.mock("dotenv/config", () => ({}))
vi.mock("tesseract.js", () => ({
  createWorker: async () => {
    writeFileSync(
      path.join(process.env.TESSERACT_CACHE_PATH!, "eng.traineddata"),
      "cached model"
    )
    return worker
  },
}))

let cache: string

beforeEach(() => {
  vi.resetModules()
  cache = mkdtempSync(path.join(tmpdir(), "anonify-warm-ocr-"))
  vi.stubEnv("TESSERACT_CACHE_PATH", cache)
  vi.stubEnv("TESSERACT_BAKED_PATH", "")
  vi.stubEnv("OCR_PROVIDER", "tesseract")
  vi.stubEnv("OCR_TESSERACT_MODEL", "standard")
  vi.stubEnv("OCR_TESSERACT_LANGUAGE", "eng")
  // The CLI must exit promptly even with the server's five-minute idle period.
  vi.stubEnv("ANONIFY_OCR_IDLE_SECONDS", "300")
  worker.recognize.mockResolvedValue({ data: { text: "" } })
  worker.terminate.mockResolvedValue(undefined)
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

afterEach(async () => {
  await closeTesseractPools()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  rmSync(cache, { recursive: true, force: true })
})

it("stops warmed workers without waiting for the pool's idle timeout", async () => {
  await import("../scripts/warm-ocr")

  await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledTimes(1))
  expect(worker.recognize).toHaveBeenCalledTimes(1)
  expect(tesseractPoolState()).toEqual([])
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Done in"))
})

it("stops workers when recognition fails during warming", async () => {
  worker.recognize.mockRejectedValueOnce(new Error("recognition failed"))
  await import("../scripts/warm-ocr")

  await vi.waitFor(() =>
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "Could not warm the OCR model: recognition failed"
      )
    )
  )
  expect(worker.terminate).toHaveBeenCalledTimes(1)
  expect(tesseractPoolState()).toEqual([])
})
