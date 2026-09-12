import { generateText, Output } from "ai"
import sharp from "sharp"
import { z } from "zod"
import { languageModel } from "./index"
import type { ModelCapabilities, ProviderEnv } from "./config"

export type ProbeResult = ModelCapabilities & {
  failure?: "structured-output" | "vision"
}

/** Synthetic inputs only. No application document, usage row, or raw error is involved. */
export async function probeModel(
  env: ProviderEnv,
  fetcher?: typeof fetch
): Promise<ProbeResult> {
  try {
    const model = await languageModel(env, fetcher)
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
      const vision = image.output.color === "red"
      return {
        structuredOutput: true,
        vision,
        ...(!vision ? { failure: "vision" as const } : {}),
      }
    } catch {
      return { structuredOutput: true, vision: false, failure: "vision" }
    }
  } catch {
    return {
      structuredOutput: false,
      vision: false,
      failure: "structured-output",
    }
  }
}
