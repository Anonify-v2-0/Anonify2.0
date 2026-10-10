import http from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it, vi } from "vitest"

import { CLOSING_FRAME, endOnServerClose } from "@/lib/api/sse"
import { healthState, markClosing, resetHealthState } from "@/lib/health/state"
import {
  closeHttpServers,
  httpRequestsInFlight,
  resetHttpTracking,
  trackHttpServers,
} from "@/lib/runtime/http-servers"
import {
  drainSettings,
  installShutdown,
  resetShutdown,
  runShutdown,
  withoutForeignSignalHandlers,
  type ShutdownDeps,
} from "@/lib/runtime/shutdown"
import {
  resetSteps,
  stepNameFromQueue,
  stepStarted,
  stepsInFlight,
} from "@/lib/runtime/steps"

/**
 * Shutting down without losing work (#182): the order of the sequence, its
 * deadline, the second signal, and the pieces it closes.
 */

afterEach(() => {
  resetHealthState()
  resetShutdown()
  resetSteps()
  vi.unstubAllEnvs()
})

function fakeDeps(overrides: Partial<ShutdownDeps> = {}) {
  let clock = 0
  const calls: string[] = []
  const logs: Record<string, unknown>[] = []
  const deps: ShutdownDeps = {
    settings: { drainMs: 10_000, readyDelayMs: 5000 },
    now: () => clock,
    sleep: async (ms) => {
      calls.push(`sleep:${ms}`)
      clock += ms
    },
    log: (fields) => logs.push(fields),
    draining: () => calls.push("draining"),
    closing: () => calls.push("closing"),
    stage: async (stage) => {
      calls.push(`stage:${stage}`)
    },
    closeHttp: async () => {
      calls.push("close-http")
      return true
    },
    disconnect: async () => {
      calls.push("disconnect")
    },
    inFlight: () => ({ steps: [], requests: 0 }),
    ...overrides,
  }
  return {
    deps,
    calls,
    logs,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

describe("the shutdown sequence", () => {
  it("drops readiness, waits, drains the workers, then closes HTTP", async () => {
    const { deps, calls } = fakeDeps()
    expect(await runShutdown("SIGTERM", deps)).toBe(0)
    expect(calls).toEqual([
      "draining",
      "sleep:5000",
      "stage:intake",
      "stage:work",
      "closing",
      "close-http",
      "stage:release",
      "disconnect",
    ])
  })

  it("never waits for readiness longer than the deadline allows", async () => {
    const { deps, calls } = fakeDeps({
      settings: { drainMs: 2000, readyDelayMs: 5000 },
    })
    await runShutdown("SIGTERM", deps)
    expect(calls[1]).toBe("sleep:2000")
  })

  it("past the deadline, names what was still running and exits 1, never content", async () => {
    const { deps, logs } = fakeDeps({
      settings: { drainMs: 50, readyDelayMs: 0 },
      now: Date.now,
      sleep: async () => {},
      // A runner that never finishes its jobs.
      stage: (stage) =>
        stage === "work" ? new Promise<void>(() => {}) : Promise.resolve(),
      inFlight: () => ({
        steps: [
          {
            step: "extractAndNormalize",
            attempt: 2,
            startedAt: Date.now() - 1000,
          },
        ],
        requests: 3,
      }),
    })
    expect(await runShutdown("SIGTERM", deps)).toBe(1)

    const deadline = logs.find((line) => line.phase === "deadline")!
    expect(deadline.steps).toEqual([
      {
        step: "extractAndNormalize",
        attempt: 2,
        runningMs: expect.any(Number),
      },
    ])
    expect(deadline.requests).toBe(3)
    expect(JSON.stringify(deadline)).not.toMatch(/doc_|payload|body/)
  })

  it("exits 1 when HTTP does not close in time", async () => {
    const { deps, calls } = fakeDeps({ closeHttp: async () => false })
    expect(await runShutdown("SIGTERM", deps)).toBe(1)
    expect(calls).not.toContain("disconnect")
  })
})

describe("the signal", () => {
  it("is taken only when the app owns it", () => {
    expect(installShutdown({}, () => {})).toBe(false)
  })

  it("exits at once on a second signal", async () => {
    const before = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    }
    const exit = vi.fn()
    expect(
      installShutdown(
        {
          NEXT_MANUAL_SIG_HANDLE: "true",
          ANONIFY_DRAIN_READY_DELAY_MS: "60000",
          ANONIFY_DRAIN_SECONDS: "120",
        },
        exit
      )
    ).toBe(true)
    try {
      process.emit("SIGTERM", "SIGTERM")
      expect(healthState().draining).toBe(true)
      expect(exit).not.toHaveBeenCalled()
      process.emit("SIGTERM", "SIGTERM")
      expect(exit).toHaveBeenCalledWith(1)
    } finally {
      for (const signal of ["SIGTERM", "SIGINT"] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener))
            process.removeListener(signal, listener)
        }
      }
    }
  })

  it("takes off the handlers a library adds while it starts", async () => {
    const theirs = () => {}
    await withoutForeignSignalHandlers(async () => {
      process.on("SIGTERM", theirs)
      process.on("SIGUSR2", theirs)
    })
    expect(process.listeners("SIGTERM")).not.toContain(theirs)
    expect(process.listeners("SIGUSR2")).not.toContain(theirs)
  })

  it("refuses a malformed drain setting", () => {
    expect(() => drainSettings({ ANONIFY_DRAIN_SECONDS: "0" })).toThrow(
      /ANONIFY_DRAIN_SECONDS/
    )
    expect(() =>
      drainSettings({ ANONIFY_DRAIN_READY_DELAY_MS: "soon" })
    ).toThrow(/ANONIFY_DRAIN_READY_DELAY_MS/)
    expect(drainSettings({})).toEqual({ drainMs: 120_000, readyDelayMs: 5000 })
  })
})

describe("steps in flight", () => {
  it("names a step by its function, and nothing else", () => {
    expect(
      stepNameFromQueue(
        "__wkf_step_step//./lib/workflows/process-document//analyze"
      )
    ).toBe("analyze")
    expect(stepNameFromQueue("__wkf_workflow_processDocument")).toBeUndefined()
    expect(stepNameFromQueue(undefined)).toBeUndefined()
    expect(stepNameFromQueue("__wkf_step_step//x//not a name; drop")).toBe(
      "unknown"
    )
  })

  it("are counted from start to finish, once", () => {
    const finish = stepStarted("analyze", 2)
    expect(stepsInFlight()).toEqual([
      { step: "analyze", attempt: 2, startedAt: expect.any(Number) },
    ])
    finish("completed")
    finish("error")
    expect(stepsInFlight()).toEqual([])
  })
})

describe("progress streams on shutdown", () => {
  async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text()
  }

  it("pass events through untouched", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id: 0\ndata: {}\n\n"))
        controller.enqueue(new TextEncoder().encode("event: end\ndata: {}\n\n"))
        controller.close()
      },
    })
    expect(await read(endOnServerClose(source))).toBe(
      "id: 0\ndata: {}\n\nevent: end\ndata: {}\n\n"
    )
  })

  it("end with a comment and no end frame when the server closes", async () => {
    let cancelled = false
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("id: 0\ndata: {}\n\n"))
      },
      cancel() {
        cancelled = true
      },
    })
    const stream = endOnServerClose(source)
    const text = read(stream)
    await new Promise((resolve) => setTimeout(resolve, 10))
    markClosing()
    const body = await text
    expect(body).toBe(`id: 0\ndata: {}\n\n${CLOSING_FRAME}`)
    expect(body).not.toContain("event: end")
    expect(cancelled).toBe(true)
  })
})

describe("closing HTTP", () => {
  afterEach(() => resetHttpTracking())

  it("waits for the requests in flight, then lets the server go", async () => {
    trackHttpServers()
    let answer = () => {}
    const server = http.createServer((_request, response) => {
      answer = () => response.end("done")
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo

    const reply = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text())
    while (httpRequestsInFlight() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const closed = closeHttpServers(Date.now() + 5000, 5)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(httpRequestsInFlight()).toBe(1)
    answer()
    expect(await reply).toBe("done")
    expect(await closed).toBe(true)
    expect(server.listening).toBe(false)
  })

  it("gives up at the deadline", async () => {
    trackHttpServers()
    const server = http.createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo
    const abort = new AbortController()
    fetch(`http://127.0.0.1:${port}/`, { signal: abort.signal }).catch(() => {})
    while (httpRequestsInFlight() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(await closeHttpServers(Date.now() + 50, 5)).toBe(false)
    abort.abort()
    server.closeAllConnections()
  })
})
