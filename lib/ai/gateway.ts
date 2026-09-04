import { generateText, Output } from "ai"
import type { z } from "zod"

import { newUsageId } from "@/lib/documents/ids"
import { prisma } from "@/lib/database/prisma"

/**
 * The model layer.
 *
 * Everything reaches the provider through the AI Gateway by model id, so
 * swapping models is configuration rather than a code change. Nothing here
 * decides anything: the model returns structured proposals, and the application
 * applies only what a person accepts.
 */

/** Cheap, fast and vision-capable — the shape of work this product does. */
const DEFAULT_MODEL = "anthropic/claude-haiku-4.5"

export function resolveModel(): string {
  return process.env.AI_MODEL?.trim() || DEFAULT_MODEL
}

export function aiConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN)
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

export type StructuredResult<T> = {
  output: T | null
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
 */
export async function runStructured<T>(
  call: StructuredCall<T>
): Promise<StructuredResult<T>> {
  const startedAt = Date.now()
  const model = resolveModel()

  if (!aiConfigured()) {
    return { output: null, inputTokens: 0, outputTokens: 0, durationMs: 0 }
  }

  try {
    const result = await generateText({
      model,
      system: call.system,
      maxRetries: call.maxRetries ?? 2,
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
    // Log the shape of the failure, never the prompt: it contains document text.
    console.error(
      JSON.stringify({
        level: "error",
        context: "ai.structured",
        documentId: call.documentId,
        task: call.task,
        model,
        durationMs: Date.now() - startedAt,
        errorCategory: categorizeAiError(error),
      })
    )
    return {
      output: null,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - startedAt,
    }
  }
}

function categorizeAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/rate.?limit|429/i.test(message)) return "rate-limit"
  if (/timeout|ETIMEDOUT|aborted/i.test(message)) return "timeout"
  if (/401|403|api.?key|unauthor/i.test(message)) return "authorization"
  if (/schema|validat|parse/i.test(message)) return "invalid-output"
  return "provider"
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
