import type { DocumentExportView } from "@/lib/documents/document-exports"
import type { TokenVault } from "@/lib/redaction/vault"
import {
  newRecipientKeyPair,
  openVaultEnvelope,
  parseEnvelope,
} from "@/lib/redaction/vault-envelope"
import { decodeDocumentExportEvent } from "@/lib/workflows/document-export-events"

/**
 * The browser's side of a background export (#187).
 *
 * The dialog makes a key pair, keeps the private half (not extractable, so it
 * never leaves the browser's key store) and sends the public half; the run
 * seals any vault to it. The private key is kept in IndexedDB by export id, so
 * closing the dialog or reloading the page while the export runs does not lose
 * the vault, and is deleted once the vaults are opened. Without IndexedDB it
 * lives in this page's memory only.
 */

const DATABASE = "anonify-export-keys"
const STORE = "keys"
const memory = new Map<string, CryptoKey>()

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
      request.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | undefined> {
  const database = await openDatabase()
  if (!database) return undefined
  try {
    return await new Promise<T | undefined>((resolve) => {
      const request = work(database.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(undefined)
    })
  } catch {
    return undefined
  } finally {
    database.close()
  }
}

export async function rememberKey(exportId: string, key: CryptoKey) {
  memory.set(exportId, key)
  await withStore("readwrite", (store) => store.put(key, exportId))
}

export async function recallKey(exportId: string): Promise<CryptoKey | null> {
  const held = memory.get(exportId)
  if (held) return held
  const stored = await withStore<CryptoKey>("readonly", (store) =>
    store.get(exportId)
  )
  return stored ?? null
}

export async function forgetKey(exportId: string) {
  memory.delete(exportId)
  await withStore("readwrite", (store) => store.delete(exportId))
}

/** Whether this page can seal and open vaults: WebCrypto needs HTTPS or localhost. */
export function canUseBackgroundExport(): boolean {
  return Boolean(globalThis.isSecureContext && globalThis.crypto?.subtle)
}

export type StartedExport =
  | { ok: true; exportId: string; view: DocumentExportView }
  | { ok: false; response: Response }

/** Asks for an export to run in the background, sending this page's key. */
export async function startBackgroundExport(
  documentId: string,
  body: Record<string, unknown>
): Promise<StartedExport> {
  const { privateKey, publicKey } = await newRecipientKeyPair()
  const response = await fetch(`/api/documents/${documentId}/export`, {
    method: "POST",
    headers: { "content-type": "application/json", prefer: "respond-async" },
    body: JSON.stringify({ ...body, recipientKey: publicKey }),
  })
  if (!response.ok) return { ok: false, response }
  const payload = (await response.json()) as {
    exportId: string
    export: DocumentExportView
  }
  await rememberKey(payload.exportId, privateKey)
  return { ok: true, exportId: payload.exportId, view: payload.export }
}

export async function readExport(
  documentId: string,
  exportId?: string
): Promise<DocumentExportView | null> {
  const url = exportId
    ? `/api/documents/${documentId}/export/${exportId}`
    : `/api/documents/${documentId}/export`
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) return null
  return ((await response.json()) as { export: DocumentExportView | null })
    .export
}

const MAX_RECONNECTS = 10

/**
 * Follows an export's progress until it finishes, then reads its final
 * state. The stream is a courtesy: when it drops or will not hold, the
 * record is read instead.
 */
export async function followExport(
  documentId: string,
  exportId: string,
  onUpdate: (update: Pick<DocumentExportView, "status" | "progress">) => void,
  signal?: AbortSignal
): Promise<DocumentExportView | null> {
  let lastIndex = -1
  let attempts = 0

  while (!signal?.aborted && attempts <= MAX_RECONNECTS) {
    try {
      const response = await fetch(
        `/api/documents/${documentId}/export/${exportId}/stream?startIndex=${lastIndex + 1}`,
        { cache: "no-store", signal, headers: { accept: "text/event-stream" } }
      )
      // 409: not running any more, so there is nothing to follow.
      if (response.status === 409) break
      if (!response.ok || !response.body) throw new Error("stream-failed")

      attempts = 0
      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .getReader()
      let buffer = ""
      let ended = false
      while (!ended) {
        const result = await reader.read()
        if (result.done) break
        buffer += result.value
        let boundary = buffer.indexOf("\n\n")
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf("\n\n")
          let data = ""
          for (const line of frame.split("\n")) {
            if (line.startsWith("id:")) lastIndex = Number(line.slice(3).trim())
            else if (line.startsWith("data:")) data += line.slice(5).trim()
            else if (line.startsWith("event:") && line.includes("end"))
              ended = true
          }
          const event = decodeDocumentExportEvent(data)
          if (event)
            onUpdate({ status: event.status, progress: event.progress })
          if (event?.type === "export.finished") ended = true
        }
      }
      if (ended) break
      throw new Error("stream-closed")
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") break
      attempts += 1
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempts))
    }
  }

  // The record, however the stream ended; asked again briefly while the run
  // writes its final state.
  for (let tries = 0; tries < 20 && !signal?.aborted; tries++) {
    const view = await readExport(documentId, exportId)
    if (view && view.status !== "queued" && view.status !== "running")
      return view
    if (view) onUpdate({ status: view.status, progress: view.progress })
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return readExport(documentId, exportId)
}

export type OpenedVaults = {
  vaults: Map<string, TokenVault>
  /** Variants whose vault could not be opened here: wrong page, or taken. */
  unopened: string[]
}

/**
 * Collects and opens each variant's vault. Each is handed over once and
 * deleted, so they are opened here and kept by the dialog; the key is
 * forgotten once nothing is left to open with it.
 */
export async function openVaults(
  view: DocumentExportView
): Promise<OpenedVaults> {
  const vaults = new Map<string, TokenVault>()
  const unopened: string[] = []
  const pending = (view.artifacts ?? []).filter((artifact) => artifact.vaultUrl)
  if (pending.length === 0) {
    await forgetKey(view.id)
    return { vaults, unopened }
  }

  const key = await recallKey(view.id)
  if (!key) {
    return { vaults, unopened: pending.map((artifact) => artifact.variant) }
  }

  let failed = false
  for (const artifact of pending) {
    try {
      const response = await fetch(artifact.vaultUrl!, { cache: "no-store" })
      if (!response.ok) {
        unopened.push(artifact.variant)
        // 410: already collected. Anything else may succeed on a retry.
        if (response.status !== 410) failed = true
        continue
      }
      const sealed = new Uint8Array(await response.arrayBuffer())
      const opened = await openVaultEnvelope(parseEnvelope(sealed), key, {
        exportId: view.id,
        variant: artifact.variant,
      })
      vaults.set(
        artifact.artifactId,
        JSON.parse(new TextDecoder().decode(opened)) as TokenVault
      )
    } catch {
      unopened.push(artifact.variant)
      failed = true
    }
  }
  if (!failed) await forgetKey(view.id)
  return { vaults, unopened }
}
