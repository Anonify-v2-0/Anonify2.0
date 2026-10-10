import { randomBytes } from "node:crypto"
import http from "node:http"
import type { AddressInfo } from "node:net"

import {
  stepNameFromQueue,
  stepStarted,
  type StepOutcome,
} from "@/lib/runtime/steps"
import {
  RELAY_HEADER,
  relayToken,
  setRelayToken,
} from "@/lib/security/workflow-guard"

/**
 * How much of a step's answer is looked at to tell a retry from a success: a
 * retry is a small JSON body naming `timeoutSeconds`. Never more than this,
 * and never logged.
 */
const ANSWER_PEEK_BYTES = 256

/**
 * Records each step delivery in lib/runtime/steps.ts, for the shutdown
 * sequence and the metrics. Returns the function that records its end.
 */
function trackStep(
  incoming: http.IncomingMessage
): ((outcome: StepOutcome) => void) | undefined {
  const header = (name: string) => {
    const value = incoming.headers[name]
    return Array.isArray(value) ? value[0] : value
  }
  const step = stepNameFromQueue(header("x-vqs-queue-name"))
  if (!step) return undefined
  return stepStarted(step, Number(header("x-vqs-message-attempt")))
}

/**
 * The loopback relay the workflow runner delivers steps through; see
 * lib/security/workflow-guard.ts for why it exists.
 *
 * Listens on 127.0.0.1 on a port the operating system picks, so nothing off
 * the machine can reach it, and forwards each request to the server on
 * `serverPort` with the process's token added. Request and response bodies
 * are piped, not buffered.
 *
 * Returns the base URL to give the world as `WORKFLOW_LOCAL_BASE_URL`.
 */
export async function startWorkflowRelay(serverPort: number): Promise<string> {
  const token = relayToken() ?? randomBytes(24).toString("base64url")
  setRelayToken(token)

  const relay = http.createServer((incoming, outgoing) => {
    const finish = trackStep(incoming)
    let outcome: StepOutcome = "error"
    outgoing.once("close", () => finish?.(outcome))

    const headers = { ...incoming.headers, [RELAY_HEADER]: token }
    // The upstream sees its own address, not the relay's port.
    headers.host = `127.0.0.1:${serverPort}`

    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: serverPort,
        method: incoming.method,
        path: incoming.url,
        headers,
      },
      (answer) => {
        const status = answer.statusCode ?? 502
        if (finish && status < 400) {
          let seen = ""
          answer.on("data", (chunk: Buffer) => {
            if (seen.length >= ANSWER_PEEK_BYTES) return
            seen += chunk.subarray(0, ANSWER_PEEK_BYTES - seen.length).toString()
          })
          // Only an answer that arrived whole counts as one.
          answer.once("end", () => {
            outcome = seen.includes('"timeoutSeconds"') ? "retry" : "completed"
          })
        }
        outgoing.writeHead(status, answer.headers)
        answer.pipe(outgoing)
      }
    )
    upstream.on("error", (error) => {
      console.error(
        JSON.stringify({
          level: "error",
          context: "workflow.relay",
          message: error.message,
        })
      )
      if (!outgoing.headersSent) outgoing.writeHead(502)
      outgoing.end()
    })
    incoming.pipe(upstream)
  })

  // A step can run for minutes, and the runner waits on the answer.
  relay.requestTimeout = 0
  relay.headersTimeout = 60_000

  await new Promise<void>((resolve, reject) => {
    relay.once("error", reject)
    relay.listen(0, "127.0.0.1", () => resolve())
  })
  // Nothing should keep the process alive for its sake.
  relay.unref()

  const { port } = relay.address() as AddressInfo
  return `http://127.0.0.1:${port}`
}
