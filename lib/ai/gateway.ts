import { generateText, Output } from "ai"
import type { z } from "zod"
import {
  languageModel,
  providerConfigured,
  selectedProvider,
} from "@/lib/ai/providers"
import { configuredCapabilities, usageModelId } from "@/lib/ai/providers/config"

import { newUsageId } from "@/lib/documents/ids"
import { prisma } from "@/lib/database/prisma"
import {
  classifyServiceError,
  runThrottled,
  type ServiceErrorKind,
} from "@/lib/services/throttle"

/**
 * The model layer.
 *
 * Everything reaches the selected AI SDK provider by model id, so
 * swapping models is configuration rather than a code change. Nothing here
 * decides anything: the model returns structured proposals, and the application
 * applies only what a person accepts.
 */

export function resolveModel(): string {
  return usageModelId()
}

export function aiConfigured(): boolean {
  return providerConfigured()
}

export type StructuredCall<T> = {
  task: string
  documentId: string
  system: string
  prompt: string
  schema: z.ZodType<T>
  /** Images to attach, as data the provider can read. */
  images?: { data: Uint8Array; mediaType: string }[]
  maxRetries?: number
}

/** Why a call produced nothing, when it did. */
export type StructuredSkip = "not-configured" | "unsupported" | ServiceErrorKind

export type StructuredResult<T> = {
  output: T | null
  /** Set only when `output` is null, and always set when it is. */
  skipped?: StructuredSkip
  inputTokens: number
  outputTokens: number
  durationMs: number
}

/**
 * One structured model call, with its cost recorded and its failure contained.
 *
 * A provider error returns null rather than throwing: detection is an assist,
 * and losing it must never cost the user the document they uploaded. The
 * deterministic detectors have already run by this point.
 *
 * What it no longer does is lose the *reason*. A rate limit, an empty balance,
 * a bad key and a malformed response all used to arrive at the caller as the
 * same silent null, so a document reviewed against pattern matching alone was
 * indistinguishable from one the model had genuinely found nothing in. Silently
 * doing less redaction than the user believes they asked for is the failure
 * this whole codebase exists to prevent; `skipped` is how the caller can say so.
 *
 * The call itself goes through the shared gate: paced under the configured
 * concurrency and rate, and retried on the failures where retrying can work.
 * The AI SDK's own `maxRetries` is left at 0 by default so the two schedules
 * cannot compound into a wait nobody chose.
 */
export async function runStructured<T>(
  call: StructuredCall<T>
): Promise<StructuredResult<T>> {
  const startedAt = Date.now()
  const model = resolveModel()

  if (!aiConfigured()) {
    return {
      output: null,
      skipped: "not-configured",
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
    }
  }

  try {
    selectedProvider()
    const capabilities = configuredCapabilities()
    if (
      !capabilities.structuredOutput ||
      (call.images?.length && !capabilities.vision)
    ) {
      return {
        output: null,
        skipped: "unsupported",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      }
    }
    const resolved = await languageModel()
    const result = await runThrottled("ai", { label: call.task }, () =>
      generateText({
        model: resolved,
        system: call.system,
        maxRetries: call.maxRetries ?? 0,
        output: Output.object({ schema: call.schema }),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: call.prompt },
              ...(call.images ?? []).map((image) => ({
                type: "file" as const,
                data: image.data,
                mediaType: image.mediaType,
              })),
            ],
          },
        ],
      })
    )

    const durationMs = Date.now() - startedAt
    const inputTokens = result.usage?.inputTokens ?? 0
    const outputTokens = result.usage?.outputTokens ?? 0

    await recordUsage({
      documentId: call.documentId,
      task: call.task,
      model,
      inputTokens,
      outputTokens,
      durationMs,
    })

    return { output: result.output, inputTokens, outputTokens, durationMs }
  } catch (error) {
    const failure = classifyServiceError(error)

    // Log the shape of the failure, never the prompt: it contains document text.
    console.error(
      JSON.stringify({
        level: "error",
        context: "ai.structured",
        documentId: call.documentId,
        task: call.task,
        model,
        durationMs: Date.now() - startedAt,
        errorCategory: failure.kind,
      })
    )
    return {
      output: null,
      skipped: failure.kind,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
    }
  }
}

/** Whether a skip is worth telling the reviewer about, or merely how it is. */
export function skipIsFailure(skip: StructuredSkip | undefined): boolean {
  return skip !== undefined && skip !== "not-configured"
}

export async function recordUsage(usage: {
  documentId: string
  task: string
  model: string
  inputTokens: number
  outputTokens: number
  durationMs: number
  chunks?: number
}): Promise<void> {
  try {
    await prisma.aiUsage.create({
      data: {
        id: newUsageId(),
        documentId: usage.documentId,
        task: usage.task,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        durationMs: usage.durationMs,
        chunks: usage.chunks ?? 1,
      },
    })
  } catch {
    // Telemetry must never break processing.
  }
}
