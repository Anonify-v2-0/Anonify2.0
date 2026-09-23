import { mistralProvider } from "@/lib/ocr/mistral"
import { tesseractProvider } from "@/lib/ocr/tesseract"
import {
  OCR_PROVIDERS,
  type OcrProvider,
  type OcrProviderName,
  type OcrResult,
  type OcrSession,
} from "@/lib/ocr/types"

/**
 * Provider selection.
 *
 * The pipeline asks for OCR and gets it; which engine answers is configuration.
 * A self-hosted install defaults to Tesseract because it needs no account, and
 * the deployed demo sets OCR_PROVIDER=mistral for the better recognition.
 *
 * Selection never fails silently: an explicitly requested provider that cannot
 * run is an error, because quietly substituting a different engine would change
 * both the quality and the geometry of every result without saying so.
 */

const PROVIDERS: Record<OcrProviderName, OcrProvider> = {
  tesseract: tesseractProvider,
  mistral: mistralProvider,
}

export function configuredProviderName(): OcrProviderName | null {
  const raw = process.env.OCR_PROVIDER?.trim().toLowerCase()
  if (!raw) return null
  return (OCR_PROVIDERS as readonly string[]).includes(raw)
    ? (raw as OcrProviderName)
    : null
}

/**
 * The configured provider cannot run on this instance.
 *
 * Its own class so the pipeline can tell it from a page that failed to read:
 * this one is identical on every attempt until an administrator changes the
 * environment, so retrying it only delays the answer.
 */
export class OcrConfigurationError extends Error {
  name = "OcrConfigurationError"
}

export type ProviderChoice = {
  provider: OcrProvider
  /** Why this one, for the log line and the setup output. */
  reason: "configured" | "default"
}

export function selectOcrProvider(): ProviderChoice {
  const requested = configuredProviderName()

  if (requested) {
    const provider = PROVIDERS[requested]
    const unavailable = provider.unavailableReason()
    if (unavailable) {
      // Falling back here would silently change the geometry of every result.
      throw new OcrConfigurationError(
        `OCR_PROVIDER=${requested} cannot be used. ${unavailable}`
      )
    }
    return { provider, reason: "configured" }
  }

  if (process.env.OCR_PROVIDER && !requested) {
    throw new OcrConfigurationError(
      `OCR_PROVIDER must be one of: ${OCR_PROVIDERS.join(", ")}`
    )
  }

  // Local by default: a fresh clone should read a scan without an account.
  return { provider: tesseractProvider, reason: "default" }
}

export async function startOcr(): Promise<OcrSession> {
  const { provider, reason } = selectOcrProvider()

  console.log(
    JSON.stringify({
      level: "info",
      context: "ocr.provider",
      provider: provider.name,
      granularity: provider.granularity,
      reason,
    })
  )

  return provider.start()
}

/** One-shot recognition, for callers with a single image. */
export async function ocrImage(bytes: Uint8Array): Promise<OcrResult> {
  const session = await startOcr()
  try {
    return await session.recognize(bytes)
  } finally {
    await session.close()
  }
}

export { PROVIDERS as OCR_PROVIDER_REGISTRY }
export type { OcrProvider, OcrResult, OcrSession }
export * from "@/lib/ocr/types"
