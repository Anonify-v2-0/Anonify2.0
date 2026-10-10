import { start } from "workflow/api"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
  readJson,
} from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import {
  documentExportView,
  latestDocumentExport,
  newDocumentExportId,
  takeVaultEnvelope,
  type DocumentExportView,
} from "@/lib/documents/document-exports"
import { exportOptionsSchema } from "@/lib/redaction/export-options"
import {
  defaultVariant,
  nameVariants,
  type VariantSpec,
} from "@/lib/redaction/variants"
import { parseVault, type TokenVault } from "@/lib/redaction/vault"
import {
  looksLikeRecipientKey,
  newRecipientKeyPair,
  openVaultEnvelope,
  parseEnvelope,
} from "@/lib/redaction/vault-envelope"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { exportSingleDocument } from "@/lib/workflows/export-document"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Generates the redacted document, in the background (#187).
 *
 * Deterministic from the accepted redactions, verified against the artifact it
 * just produced, checksummed and stored encrypted, as it always was. What
 * changed is where: the work is a durable run on the workers
 * (lib/workflows/export-document.ts), so it no longer holds the web tier, is
 * not lost when a replica is replaced, and reports its progress.
 *
 * With `Prefer: respond-async` (what the export dialog sends) the answer is
 * a 202 naming the export, its status and its progress stream, and the body
 * must carry `recipientKey`: the browser's ECDH P-256 public key, which any
 * vault is sealed to (docs/security-internals.md §11).
 *
 * Without it, the old synchronous answer, for one release: the same run,
 * awaited, with each vault sealed to a key that lives only in this request
 * and opened here. Deprecated, and removed in 1.18.0.
 */

/** The release that removes the synchronous answer. */
export const SYNC_EXPORT_REMOVED_IN = "1.18.0"

/** When it was deprecated, as RFC 9745's `Deprecation` date (2026-10-11). */
const SYNC_DEPRECATED_AT = Date.UTC(2026, 9, 11) / 1000

const DEPRECATION_HEADERS = {
  deprecation: `@${SYNC_DEPRECATED_AT}`,
  link: '<https://github.com/Anonify-v2-0/Anonify2.0/blob/main/docs/api.md#post-apidocumentsidexport>; rel="deprecation"; type="text/markdown"',
}

/** How long the synchronous answer waits for its run, inside maxDuration. */
const SYNC_WAIT_MS = 280_000
const SYNC_POLL_MS = 250

let lastDeprecationLog = -Infinity

function prefersAsync(request: Request): boolean {
  return (request.headers.get("prefer") ?? "")
    .split(",")
    .some((token) => token.trim().toLowerCase() === "respond-async")
}

export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    // No body is the default export. A body that does not parse is the
    // caller's mistake, and is answered as one rather than as a 500.
    const body = ((await readJson(request)) ?? {}) as Record<string, unknown>
    const parsed = exportOptionsSchema.safeParse(body)
    if (!parsed.success) {
      return errorResponse("Invalid export options", 400)
    }
    const options = parsed.data
    const asynchronous = prefersAsync(request)

    // The browser's key, which any vault is sealed to. Required for the
    // background answer: without it a vault could only be stored somewhere
    // Anonify can read, which is exactly what this design exists to avoid.
    if (asynchronous && !looksLikeRecipientKey(body.recipientKey)) {
      return errorResponse(
        "A background export needs recipientKey: a raw ECDH P-256 public key, base64url. See docs/api.md.",
        400
      )
    }

    const specs: VariantSpec[] = options.variants ?? []
    const variants =
      specs.length > 0 ? nameVariants(specs) : [defaultVariant(options)]

    // Charged once per variant, before any work starts. Each one is a full
    // pass over the document — its own plan, its own rasterisation, its own
    // verification — so a four-variant export that spent one allowance would
    // be four exports at the price of one, which is the shape of request
    // somebody eventually notices. Refused whole rather than truncated to
    // what the allowance covers: a reviewer who asked for a tokenised copy
    // and silently got only the masked one has been told something untrue.
    let limit = await consumeRateLimit(
      "export",
      identity?.networkKey ?? "anonymous"
    )
    for (let taken = 1; limit.allowed && taken < variants.length; taken++) {
      limit = await consumeRateLimit(
        "export",
        identity?.networkKey ?? "anonymous"
      )
    }
    if (!limit.allowed) {
      return rateLimitResponse(limit, "exports")
    }

    // The synchronous answer seals to a key held by this request alone.
    const ephemeral = asynchronous ? null : await newRecipientKeyPair()
    const recipientKey = asynchronous
      ? (body.recipientKey as string)
      : ephemeral!.publicKey

    const exportId = newDocumentExportId()
    await prisma.documentExport.create({
      data: {
        id: exportId,
        documentId: document.id,
        status: "queued",
        variants,
        metadataSanitized: options.sanitizeMetadata,
        recipientKey,
      },
    })
    const run = await start(exportSingleDocument, [exportId])
    await prisma.documentExport.update({
      where: { id: exportId },
      data: { workflowRunId: run.runId },
    })

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.export",
        documentId: document.id,
        exportId,
        workflowId: run.runId,
        variants: variants.length,
        asynchronous,
      })
    )

    if (asynchronous) {
      const record = await prisma.documentExport.findUniqueOrThrow({
        where: { id: exportId },
      })
      const view = await documentExportView(record, document)
      return jsonResponse(
        {
          exportId,
          statusUrl: `/api/documents/${document.id}/export/${exportId}`,
          streamUrl: view.streamUrl,
          export: view,
        },
        202
      )
    }

    const response = await awaitSynchronously(
      document,
      exportId,
      ephemeral!.privateKey
    )
    for (const [name, value] of Object.entries(DEPRECATION_HEADERS))
      response.headers.set(name, value)
    if (Date.now() - lastDeprecationLog > 60 * 60 * 1000) {
      lastDeprecationLog = Date.now()
      console.warn(
        JSON.stringify({
          level: "warn",
          context: "documents.export.deprecated",
          message: `POST /api/documents/:id/export without "Prefer: respond-async" is deprecated and its synchronous answer is removed in ${SYNC_EXPORT_REMOVED_IN}. Send the header and a recipientKey, and follow the export (docs/api.md).`,
        })
      )
    }
    return response
  } catch (error) {
    return handleRouteError(error, "documents.export")
  }
}

/**
 * The old answer: the run awaited, its vaults opened with the key this
 * request made, and handed back inline, as before. The envelopes are taken
 * (read once, deleted), and the private key never leaves this function.
 */
async function awaitSynchronously(
  document: Awaited<ReturnType<typeof requireDocument>>,
  exportId: string,
  privateKey: CryptoKey
): Promise<Response> {
  const deadline = Date.now() + SYNC_WAIT_MS
  let record = await prisma.documentExport.findUniqueOrThrow({
    where: { id: exportId },
  })
  while (
    (record.status === "queued" || record.status === "running") &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, SYNC_POLL_MS))
    record = await prisma.documentExport.findUniqueOrThrow({
      where: { id: exportId },
    })
  }

  if (record.status === "queued" || record.status === "running") {
    return jsonResponse(
      {
        error:
          "The export is still running. Follow it with the export id, or use Prefer: respond-async.",
        exportId,
      },
      504
    )
  }
  if (record.status !== "ready") {
    const message = record.error ?? "The export could not be completed."
    const status = /not ready/i.test(message) ? 409 : 500
    return errorResponse(message, status)
  }

  const view: DocumentExportView = await documentExportView(record, document)
  const described = await Promise.all(
    (view.artifacts ?? []).map(async (artifact) => {
      let vault: TokenVault | null = null
      if (artifact.vaultUrl) {
        const sealed = await takeVaultEnvelope(
          document,
          exportId,
          artifact.artifactId
        )
        if (sealed) {
          vault = parseVault(
            await openVaultEnvelope(parseEnvelope(sealed), privateKey, {
              exportId,
              variant: artifact.variant,
            })
          )
        }
      }
      const { vaultUrl: _vaultUrl, ...rest } = artifact
      void _vaultUrl
      // Handed over inline and stored nowhere, as before.
      return { ...rest, vault }
    })
  )

  const [primary] = described
  return jsonResponse({
    ...primary,
    metadataSanitized: record.metadataSanitized,
    artifacts: described,
  })
}

/** The newest export of this document, for a dialog opened again. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)
    const record = await latestDocumentExport(document.id)
    return jsonResponse({
      export: record ? await documentExportView(record, document) : null,
    })
  } catch (error) {
    return handleRouteError(error, "documents.export")
  }
}
