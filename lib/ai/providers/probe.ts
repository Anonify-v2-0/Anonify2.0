import { generateText, Output } from "ai"
import sharp from "sharp"
import { z } from "zod"
import { languageModel } from "./index"
import type { ModelCapabilities, ProviderEnv } from "./config"
import { describeProbeError, type ProbeFailureReason } from "./probe-errors"

export type ProbeResult = ModelCapabilities & {
  failure?: "structured-output" | "vision"
  /** Why, when `failure` is set: a category, and a sentence safe to print. */
  reason?: ProbeFailureReason
  detail?: string
}

/**
 * Synthetic inputs only. No application document or usage row is involved,
 * and what a provider says back is shown only after redaction (see
 * ./probe-errors).
 */
export async function probeModel(
  env: ProviderEnv,
  fetcher?: typeof fetch
): Promise<ProbeResult> {
  let model: Awaited<ReturnType<typeof languageModel>>
  try {
    model = await languageModel(env, fetcher)
    const text = await generateText({
      model,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120_000),
      output: Output.object({ schema: z.object({ answer: z.number() }) }),
      prompt: "Return the result of 2 + 3 in the answer field.",
    })
    if (text.output.answer !== 5)
      return {
        structuredOutput: false,
        vision: false,
        failure: "structured-output",
        reason: "wrong-answer",
        detail: `The model returned valid JSON, but answered ${JSON.stringify(text.output.answer)} to 2 + 3. It is too unreliable to trust with redaction.`,
      }
  } catch (error) {
    return {
      structuredOutput: false,
      vision: false,
      failure: "structured-output",
      ...describeProbeError(error, env, "structured"),
    }
  }

  try {
    const data = await sharp({
      create: { width: 32, height: 32, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer()
    const image = await generateText({
      model,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(120_000),
      output: Output.object({
        schema: z.object({
          color: z.enum(["red", "green", "blue", "white", "black"]),
        }),
      }),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What is the dominant color of the attached image?",
            },
            { type: "file", data, mediaType: "image/png" },
          ],
        },
      ],
    })
    if (image.output.color === "red")
      return { structuredOutput: true, vision: true }
    return {
      structuredOutput: true,
      vision: false,
      failure: "vision",
      reason: "wrong-answer",
      detail: `The model read the image, but called a plain red square "${image.output.color}".`,
    }
  } catch (error) {
    return {
      structuredOutput: true,
      vision: false,
      failure: "vision",
      ...describeProbeError(error, env, "image"),
    }
  }
}
