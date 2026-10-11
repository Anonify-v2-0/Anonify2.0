/**
 * One virtual reviewer (#190): its own session, talking to the HTTP API the
 * way the browser does.
 *
 * It seals each upload with the same code the browser and `pnpm smoke` use
 * (`lib/storage/chunked-web`), sends it by whichever path the install
 * answers with (presigned to the bucket, or streamed through the app), starts
 * each run, polls the batch the way the batch view does, accepts what was
 * found and exports in the background. So the server sees what it would see
 * from people, and the numbers are about the server.
 *
 * Every request is timed under a route label with the ids taken out, so the
 * report can give p95 latency per route and not per document.
 */

import {
  decodeUploadKey,
  sealFileForUpload,
  type UploadEncryption,
} from "@/lib/storage/chunked-web"
import { newRecipientKeyPair } from "@/lib/redaction/vault-envelope"

import type { Fixture } from "./fixtures"

/** Request timings by route, and every failure by route and status. */
export class Recorder {
  readonly latencies = new Map<string, number[]>()
  readonly failures = new Map<string, number>()
  /** 429s, kept apart: they mean the target's rate limits, not its capacity. */
  readonly throttled = new Map<string, number>()

  time(route: string, ms: number): void {
    const list = this.latencies.get(route) ?? []
    list.push(ms)
    this.latencies.set(route, list)
  }

  fail(route: string, status: number | "network"): void {
    const key = `${route} ${status}`
    if (status === 429)
      this.throttled.set(route, (this.throttled.get(route) ?? 0) + 1)
    else this.failures.set(key, (this.failures.get(key) ?? 0) + 1)
  }
}

export class HttpError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    body: string
  ) {
    super(`${route} answered ${status}: ${body.slice(0, 200)}`)
  }
}

type ExportView = {
  id: string
  status: string
  error: string | null
  artifacts: { downloadUrl: string; size: number }[] | null
}

export type Uploaded = {
  id: string
  fixture: Fixture
  /** When `process` was accepted: time-to-ready is measured from here. */
  startedAt: number
}

export type DocumentState = {
  id: string
  status: string
  kind: string
  pageCount: number | null
  error?: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class Reviewer {
  private readonly cookies = new Map<string, string>()
  /** The last batch body and its tag, so a poll can answer 304 as it does in the browser. */
  private readonly etags = new Map<string, { tag: string; body: unknown }>()
  /** What this reviewer is doing now, for the live view. */
  activity = { what: "idle", since: Date.now() }

  constructor(
    readonly name: string,
    private readonly base: string,
    public recorder: Recorder
  ) {}

  doing(what: string): void {
    if (what !== this.activity.what) this.activity = { what, since: Date.now() }
  }

  private remember(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";")
      const index = pair.indexOf("=")
      if (index > 0)
        this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1))
    }
  }

  /** One request to the app, timed under `route`. Throws on anything but 2xx/304. */
  async call(
    route: string,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0)
      headers.set(
        "cookie",
        [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
      )
    const started = performance.now()
    let response: Response
    try {
      response = await fetch(`${this.base}${path}`, { ...init, headers })
    } catch (error) {
      this.recorder.fail(route, "network")
      throw error
    }
    this.remember(response)
    if (!response.ok && response.status !== 304) {
      const body = await response.text().catch(() => "")
      this.recorder.time(route, performance.now() - started)
      this.recorder.fail(route, response.status)
      throw new HttpError(route, response.status, body)
    }
    // A body is part of the answer; time it to the last byte the caller reads.
    const buffered = await response.arrayBuffer()
    this.recorder.time(route, performance.now() - started)
    return new Response(response.status === 304 ? null : buffered, {
      status: response.status,
      headers: response.headers,
    })
  }

  async json<T>(
    route: string,
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    return (await (await this.call(route, path, init)).json()) as T
  }

  private post(body: unknown, extra: Record<string, string> = {}): RequestInit {
    return {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(body),
    }
  }

  /** The session cookie, minted by the first page load as in a browser. */
  async open(): Promise<void> {
    await this.call("GET /", "/")
  }

  /**
   * A batch, as the upload panel sends one: reserve every file, seal and
   * upload them one after another, then start each run. Returns the batch and
   * the documents that started; a file the server refused is counted, not
   * retried.
   */
  async uploadBatch(
    fixtures: Fixture[]
  ): Promise<{ batchId: string; uploaded: Uploaded[]; refused: number }> {
    this.doing(`reserving ${fixtures.length} file(s)`)
    const reserved = await this.json<{
      batchId: string
      uploadMode: string
      accepted: {
        index: number
        id: string
        pathname: string
        uploadEncryption: UploadEncryption | null
      }[]
      refused?: unknown[]
    }>(
      "POST /api/batches",
      "/api/batches",
      this.post({
        files: fixtures.map((fixture) => ({
          filename: fixture.filename,
          size: fixture.bytes.byteLength,
          contentType: fixture.contentType,
        })),
        ttlSeconds: 3600,
        preset: "everything",
        uploadEncryption: "v1",
      })
    )
    if (reserved.uploadMode === "vercel-blob")
      throw new Error(
        "This install uploads straight to Vercel Blob with a browser token; " +
          "the load harness drives self-hosted upload modes only."
      )

    const handles: {
      item: (typeof reserved.accepted)[number]
      handle: string
    }[] = []
    for (const [position, item] of reserved.accepted.entries()) {
      const fixture = fixtures[item.index]
      this.doing(
        `uploading ${position + 1}/${reserved.accepted.length} · ${fixture.format}`
      )
      if (!item.uploadEncryption)
        throw new Error("the reservation asked for an upload key and got none")
      const sealed = await sealFileForUpload({
        file: new Blob([new Uint8Array(fixture.bytes)]),
        key: decodeUploadKey(item.uploadEncryption.key),
        logicalKey: item.pathname,
        chunkShift: item.uploadEncryption.chunkShift,
      })
      handles.push({
        item,
        handle: await this.upload(item.id, sealed, reserved.uploadMode),
      })
    }

    // The panel starts each run as its upload finishes; started here in the
    // same order, after the last byte, which is what a slow link looks like.
    const uploaded: Uploaded[] = []
    this.doing(`starting ${handles.length} run(s)`)
    for (const { item, handle } of handles) {
      await this.json(
        "POST /api/documents/:id/process",
        `/api/documents/${item.id}/process`,
        this.post({ blobUrl: handle })
      )
      uploaded.push({
        id: item.id,
        fixture: fixtures[item.index],
        startedAt: Date.now(),
      })
    }
    return {
      batchId: reserved.batchId,
      uploaded,
      refused: reserved.refused?.length ?? 0,
    }
  }

  private async upload(
    documentId: string,
    sealed: Blob,
    mode: string
  ): Promise<string> {
    if (mode === "s3-presigned") {
      const signed = await this.json<{
        url: string
        headers: Record<string, string>
        handle: string
      }>(
        "POST /api/upload/presign",
        "/api/upload/presign",
        this.post({ documentId, size: sealed.size })
      )
      const started = performance.now()
      const put = await fetch(signed.url, {
        method: "PUT",
        headers: signed.headers,
        body: sealed,
      })
      this.recorder.time("PUT <bucket>", performance.now() - started)
      if (!put.ok) {
        this.recorder.fail("PUT <bucket>", put.status)
        throw new HttpError("PUT <bucket>", put.status, await put.text())
      }
      return signed.handle
    }
    const uploaded = await this.json<{ url: string }>(
      "PUT /api/upload/local",
      `/api/upload/local?documentId=${encodeURIComponent(documentId)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: sealed,
      }
    )
    return uploaded.url
  }

  /** The batch view's poll, with its ETag. */
  async batch(batchId: string): Promise<DocumentState[]> {
    const path = `/api/batches/${batchId}`
    const previous = this.etags.get(path)
    const response = await this.call(
      "GET /api/batches/:id",
      path,
      previous ? { headers: { "if-none-match": previous.tag } } : {}
    )
    if (response.status === 304 && previous)
      return (previous.body as { batch: { documents: DocumentState[] } }).batch
        .documents
    const body = (await response.json()) as {
      batch: { documents: DocumentState[] }
    }
    const tag = response.headers.get("etag")
    if (tag) this.etags.set(path, { tag, body })
    return body.batch.documents
  }

  /**
   * Polls the batch until every document in `waiting` is ready or failed, or
   * `deadline` passes. Calls `settled` once per document as it settles, with
   * the time it was first seen settled.
   */
  async waitForBatch(
    batchId: string,
    waiting: Uploaded[],
    deadline: number,
    settled: (document: Uploaded, state: DocumentState, at: number) => void,
    intervalMs = 1000
  ): Promise<Uploaded[]> {
    const open = new Map(waiting.map((document) => [document.id, document]))
    while (open.size > 0 && Date.now() < deadline) {
      this.doing(
        `waiting · ${waiting.length - open.size}/${waiting.length} settled`
      )
      let states: DocumentState[] = []
      try {
        states = await this.batch(batchId)
      } catch {
        // A failed poll is recorded by `call`; the next one may answer.
      }
      const at = Date.now()
      for (const state of states) {
        const document = open.get(state.id)
        if (!document) continue
        if (state.status === "ready" || state.status === "failed") {
          open.delete(state.id)
          settled(document, state, at)
        }
      }
      if (open.size > 0) await sleep(intervalMs)
    }
    return [...open.values()]
  }

  /** Accepts every suggestion, as "Accept all" does. Returns how many. */
  async acceptAll(documentId: string): Promise<number> {
    this.doing("accepting suggestions")
    const { redactions } = await this.json<{ redactions: { id: string }[] }>(
      "GET /api/documents/:id/redactions",
      `/api/documents/${documentId}/redactions`
    )
    if (redactions.length === 0) return 0
    await this.json(
      "PATCH /api/documents/:id/redactions",
      `/api/documents/${documentId}/redactions`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ids: redactions.map((redaction) => redaction.id),
          status: "accepted",
        }),
      }
    )
    return redactions.length
  }

  /**
   * An export in the background, as the dialog asks for one (#187), polled
   * to the end and downloaded. Returns the milliseconds it took end to end.
   */
  async exportAndDownload(
    documentId: string,
    deadline: number
  ): Promise<number> {
    const started = Date.now()
    this.doing("exporting")
    const recipient = await newRecipientKeyPair()
    const run = await this.json<{ statusUrl: string }>(
      "POST /api/documents/:id/export",
      `/api/documents/${documentId}/export`,
      this.post(
        {
          addLabels: false,
          sanitizeMetadata: true,
          recipientKey: recipient.publicKey,
        },
        { prefer: "respond-async" }
      )
    )
    for (;;) {
      const { export: view } = await this.json<{ export: ExportView }>(
        "GET /api/documents/:id/export/:exportId",
        run.statusUrl
      )
      if (view.status === "ready") {
        const artifact = view.artifacts?.[0]
        if (!artifact) throw new Error("the finished export has no artifact")
        this.doing("downloading")
        await this.call("GET <download>", artifact.downloadUrl)
        return Date.now() - started
      }
      if (view.status === "failed" || view.status === "cancelled")
        throw new Error(`export ${view.status}: ${view.error ?? "no reason"}`)
      if (Date.now() > deadline)
        throw new Error("export did not finish in time")
      await sleep(500)
    }
  }

  async remove(documentId: string): Promise<void> {
    this.doing("deleting")
    await this.call(
      "DELETE /api/documents/:id",
      `/api/documents/${documentId}`,
      { method: "DELETE" }
    )
  }

  /**
   * Follows one document's progress stream and returns how late each event
   * arrived: the client's clock at arrival minus the event's own `at`. Ends
   * with the stream, or when `signal` aborts.
   */
  async followStream(
    documentId: string,
    signal: AbortSignal
  ): Promise<number[]> {
    const lags: number[] = []
    const headers = new Headers({ accept: "text/event-stream" })
    headers.set(
      "cookie",
      [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ")
    )
    let response: Response
    try {
      response = await fetch(
        `${this.base}/api/documents/${documentId}/stream`,
        {
          headers,
          signal,
        }
      )
    } catch {
      return lags
    }
    if (!response.ok || !response.body) return lags
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true })
        let end: number
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = frame
            .split("\n")
            .find((line) => line.startsWith("data: "))
            ?.slice("data: ".length)
          if (!data) continue
          try {
            const event = JSON.parse(data) as { at?: string }
            if (event.at) lags.push(Date.now() - Date.parse(event.at))
          } catch {
            /* not an event this measures */
          }
        }
      }
    } catch {
      /* aborted, or the replica drained it: either way, what arrived counts */
    }
    return lags
  }
}
