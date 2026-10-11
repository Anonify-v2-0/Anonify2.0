import http from "node:http"
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it, vi } from "vitest"

import {
  anonifyRole,
  assertRoleStorage,
  runsWorker,
  servesTraffic,
} from "@/lib/config/role"
import { workerAllows } from "@/lib/config/worker-gate"
import {
  cameThroughRelay,
  guardsWorkflowRoutes,
  RELAY_HEADER,
  relayToken,
} from "@/lib/security/workflow-guard"
import { startWorkflowRelay } from "@/lib/security/workflow-relay"

/**
 * Process roles (#179): which process serves people and which processes
 * documents, and who may deliver a workflow step to either.
 */

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("ANONIFY_ROLE", () => {
  it("is all unless set, which serves and works exactly as before", () => {
    expect(anonifyRole({})).toBe("all")
    expect(anonifyRole({ ANONIFY_ROLE: " " })).toBe("all")
    expect(runsWorker({})).toBe(true)
    expect(servesTraffic({})).toBe(true)
  })

  it("splits serving from processing", () => {
    expect(anonifyRole({ ANONIFY_ROLE: "Web" })).toBe("web")
    expect(runsWorker({ ANONIFY_ROLE: "web" })).toBe(false)
    expect(servesTraffic({ ANONIFY_ROLE: "web" })).toBe(true)
    expect(runsWorker({ ANONIFY_ROLE: "worker" })).toBe(true)
    expect(servesTraffic({ ANONIFY_ROLE: "worker" })).toBe(false)
  })

  it("refuses anything else, naming the choices", () => {
    expect(() => anonifyRole({ ANONIFY_ROLE: "workers" })).toThrow(
      /ANONIFY_ROLE must be one of all, web, worker, got "workers"/
    )
  })

  it("refuses the local disk in a split deployment, and only there", () => {
    expect(() => assertRoleStorage("local", {})).not.toThrow()
    expect(() => assertRoleStorage("s3", { ANONIFY_ROLE: "web" })).not.toThrow()
    expect(() => assertRoleStorage("local", { ANONIFY_ROLE: "web" })).toThrow(
      /needs shared storage/
    )
    expect(() =>
      assertRoleStorage("local", { ANONIFY_ROLE: "worker" })
    ).toThrow(/STORAGE_DRIVER/)
  })
})

describe("the worker's gate", () => {
  it("lets through the runner's routes and the probes, and nothing else", () => {
    expect(workerAllows("/.well-known/workflow/v1/step")).toBe(true)
    expect(workerAllows("/.well-known/workflow/v1/flow?__health")).toBe(true)
    expect(workerAllows("/api/health")).toBe(true)
    expect(workerAllows("/api/ready?x=1")).toBe(true)
    expect(workerAllows("/api/metrics")).toBe(true)

    expect(workerAllows("/")).toBe(false)
    expect(workerAllows("/api/documents")).toBe(false)
    expect(workerAllows("/api/health/../documents")).toBe(false)
    expect(workerAllows("/documents")).toBe(false)
    expect(workerAllows(undefined)).toBe(false)
  })
})

describe("workflow deliveries", () => {
  it("are guarded wherever a world of our own is configured", () => {
    expect(guardsWorkflowRoutes({})).toBe(false)
    expect(
      guardsWorkflowRoutes({
        WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
      })
    ).toBe(true)
  })

  it("are admitted only with this process's token, through its relay", async () => {
    // A server standing in for Next: it reports what the guard would decide.
    const server = http.createServer((request, response) => {
      const headers = new Headers()
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string") headers.set(name, value)
      }
      let body = ""
      request.on("data", (chunk) => (body += chunk))
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" })
        response.end(
          JSON.stringify({
            admitted: cameThroughRelay(headers),
            host: request.headers.host,
            path: request.url,
            body,
          })
        )
      })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const { port } = server.address() as AddressInfo

    try {
      const relay = await startWorkflowRelay(port)
      expect(relay).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      expect(relayToken()).toBeTruthy()

      const through = await fetch(`${relay}/.well-known/workflow/v1/step`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: 1 }),
      })
      expect(await through.json()).toEqual({
        admitted: true,
        host: `127.0.0.1:${port}`,
        path: "/.well-known/workflow/v1/step",
        body: '{"step":1}',
      })

      // Straight at the server, even from this machine: refused.
      const direct = await fetch(
        `http://127.0.0.1:${port}/.well-known/workflow/v1/step`,
        {
          method: "POST",
          body: "{}",
        }
      )
      expect((await direct.json()).admitted).toBe(false)

      // And a guessed token is refused too.
      const forged = await fetch(`http://127.0.0.1:${port}/x`, {
        headers: { [RELAY_HEADER]: "a".repeat(32) },
      })
      expect((await forged.json()).admitted).toBe(false)
    } finally {
      server.close()
    }
  })

  it("admits nothing in a process that never started a relay", () => {
    const shared = globalThis as unknown as { anonifyRelayToken?: string }
    const saved = shared.anonifyRelayToken
    delete shared.anonifyRelayToken
    try {
      expect(cameThroughRelay(new Headers({ [RELAY_HEADER]: "" }))).toBe(false)
      expect(cameThroughRelay(new Headers())).toBe(false)
    } finally {
      shared.anonifyRelayToken = saved
    }
  })
})
