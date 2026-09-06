/**
 * Which model each OCR engine uses.
 *
 * Choosing the engine was already configuration; choosing the model behind it
 * was not. Tesseract ran the one English integer model tesseract.js happens to
 * default to, and Mistral ran a hardcoded constant — so an operator with a
 * cabinet of difficult scans, or documents that are not in English, had no way
 * to ask for anything better, and the answer was to edit the source.
 *
 * Every value here is validated against a closed list, and that is the point
 * rather than an implementation detail. These variables are read inside a
 * container started from a compose file: a typo in free text becomes an image
 * that builds, starts, accepts an upload, and fails on the first scanned page
 * with a 404 from a CDN. Validated at the point the answer is given, the same
 * typo is a re-prompt in `pnpm setup` and never leaves the terminal.
 */

// --- Tesseract --------------------------------------------------------------

export const TESSERACT_MODELS = ["fast", "standard", "best"] as const

export type TesseractModel = (typeof TESSERACT_MODELS)[number]

export const DEFAULT_TESSERACT_MODEL: TesseractModel = "standard"

/**
 * Where each variant's `.traineddata` comes from.
 *
 * `standard` is `null` on purpose: it means "leave `langPath` unset and take
 * tesseract.js's own default", which is `@tesseract.js-data/<lang>/4.0.0_best_int`
 * — the LSTM-only integer model, about 3 MB. Hardcoding that URL here would
 * pin today's default and quietly diverge from the library on its next release,
 * so the default stays the library's to choose.
 *
 * The other two come from the CDN tesseract.js has always used, which serves
 * all three variants gzipped for every language in `TESSERACT_LANGUAGES`.
 */
const TESSDATA_CDN = "https://tessdata.projectnaptha.com"

export const TESSERACT_MODEL_DETAIL: Record<
  TesseractModel,
  { langPath: string | null; approxMb: number; summary: string }
> = {
  fast: {
    langPath: `${TESSDATA_CDN}/4.0.0_fast`,
    approxMb: 2,
    summary: "Smallest and quickest. Loses accuracy on poor scans.",
  },
  standard: {
    langPath: null,
    approxMb: 3,
    summary: "The balance tesseract.js ships with. Right for most documents.",
  },
  best: {
    langPath: `${TESSDATA_CDN}/4.0.0_best`,
    approxMb: 13,
    summary: "Float model. Slowest and largest, best on difficult scans.",
  },
}

/**
 * Languages confirmed present in all three variants.
 *
 * Deliberately not every language Tesseract has data for. A list is only worth
 * having if every entry in it works, and an entry that exists in one variant
 * and 404s in another would reintroduce exactly the failure this file removes.
 */
export const TESSERACT_LANGUAGES = [
  "eng",
  "deu",
  "fra",
  "spa",
  "ita",
  "por",
  "nld",
  "pol",
  "rus",
  "tur",
  "ara",
  "hin",
  "jpn",
  "kor",
  "chi_sim",
] as const

export type TesseractLanguage = (typeof TESSERACT_LANGUAGES)[number]

export const DEFAULT_TESSERACT_LANGUAGE: TesseractLanguage = "eng"

/** What each code is, for the setup prompt and the documentation. */
export const TESSERACT_LANGUAGE_NAMES: Record<TesseractLanguage, string> = {
  eng: "English",
  deu: "German",
  fra: "French",
  spa: "Spanish",
  ita: "Italian",
  por: "Portuguese",
  nld: "Dutch",
  pol: "Polish",
  rus: "Russian",
  tur: "Turkish",
  ara: "Arabic",
  hin: "Hindi",
  jpn: "Japanese",
  kor: "Korean",
  chi_sim: "Chinese (simplified)",
}

export class InvalidOcrModelError extends Error {
  constructor(variable: string, raw: string, allowed: readonly string[]) {
    super(`${variable} must be one of: ${allowed.join(", ")} — got "${raw}"`)
    this.name = "InvalidOcrModelError"
  }
}

export function tesseractModel(): TesseractModel {
  const raw = process.env.OCR_TESSERACT_MODEL?.trim().toLowerCase()
  if (!raw) return DEFAULT_TESSERACT_MODEL

  if (!(TESSERACT_MODELS as readonly string[]).includes(raw)) {
    throw new InvalidOcrModelError("OCR_TESSERACT_MODEL", raw, TESSERACT_MODELS)
  }

  return raw as TesseractModel
}

/**
 * The configured language, as Tesseract wants it.
 *
 * `+` joins several — `eng+deu` for a document that mixes them — so each
 * segment is validated separately rather than the whole string being matched
 * against the list. Order is preserved because Tesseract treats the first as
 * primary.
 */
export function tesseractLanguage(): string {
  const raw = process.env.OCR_TESSERACT_LANGUAGE?.trim()
  if (!raw) return DEFAULT_TESSERACT_LANGUAGE

  const segments = raw
    .split("+")
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment.length > 0)

  if (segments.length === 0) {
    throw new InvalidOcrModelError(
      "OCR_TESSERACT_LANGUAGE",
      raw,
      TESSERACT_LANGUAGES
    )
  }

  for (const segment of segments) {
    if (!(TESSERACT_LANGUAGES as readonly string[]).includes(segment)) {
      throw new InvalidOcrModelError(
        "OCR_TESSERACT_LANGUAGE",
        segment,
        TESSERACT_LANGUAGES
      )
    }
  }

  return segments.join("+")
}

/** The language codes a session will load, which is what gets cached on disk. */
export function tesseractLanguageCodes(): string[] {
  return tesseractLanguage().split("+")
}

/**
 * The `langPath` for the configured variant, or `null` for the library default.
 *
 * The variant is part of the cached filename's *content* but not its name —
 * tesseract.js writes `<lang>.traineddata` whichever variant it fetched — so
 * changing the variant on an install that already has a cache must invalidate
 * it. `cacheDirectory()` in tesseract.ts handles that by putting each variant
 * in its own directory.
 */
export function tesseractLangPath(): string | null {
  return TESSERACT_MODEL_DETAIL[tesseractModel()].langPath
}

// --- Mistral ----------------------------------------------------------------

/**
 * Mistral's OCR models.
 *
 * `mistral-ocr-latest` is an alias that follows their newest, which is the
 * right default for a redaction tool: a better reader is strictly better here,
 * and there is no output format to break. The dated id is listed so an install
 * that has validated its results against one release can stay on it.
 */
export const MISTRAL_OCR_MODELS = [
  "mistral-ocr-latest",
  "mistral-ocr-2505",
] as const

export type MistralOcrModel = (typeof MISTRAL_OCR_MODELS)[number]

export const DEFAULT_MISTRAL_OCR_MODEL: MistralOcrModel = "mistral-ocr-latest"

export function mistralOcrModel(): MistralOcrModel {
  const raw = process.env.MISTRAL_OCR_MODEL?.trim().toLowerCase()
  if (!raw) return DEFAULT_MISTRAL_OCR_MODEL

  if (!(MISTRAL_OCR_MODELS as readonly string[]).includes(raw)) {
    throw new InvalidOcrModelError(
      "MISTRAL_OCR_MODEL",
      raw,
      MISTRAL_OCR_MODELS
    )
  }

  return raw as MistralOcrModel
}
