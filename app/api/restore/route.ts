import {
  errorResponse,
  handleRouteError,
  rateLimitResponse,
  readFormData,
} from "@/lib/api/http"
import { MAX_UPLOAD_BYTES } from "@/lib/config"
import { detectDocumentType } from "@/lib/documents/detect"
import { isRestorable, restoreDocument } from "@/lib/redaction/restore"
import { InvalidValueKeyError, InvalidVaultError, parseVault } from "@/lib/redaction/vault"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Putting the values back into an export.
 *
 * The reviewer uploads the redacted document and the vault that came with it,
 * and gets the original back. Nothing is stored: the bytes are restored in
 * memory and streamed back in the response, and the vault — which carries the
 * values and the key — is read, used and dropped. This route is the one place
 * in the application where original values pass through the server *into* a
 * file rather than out of one, so it holds nothing, records nothing beyond the
 * counts, and has no document to be associated with afterwards.
 *
 * It takes no document id, and that is deliberate rather than an oversight.
 * The reviewer holds both halves; the tool does not need to remember the
 * export to reverse it, and a version that did would be a version that could
 * reverse it without them.
 */
export async function POST(request: Request) {
  try {
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "export",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) return rateLimitResponse(limit, "restores")

    const form = await readFormData(request)
    if (!form) return errorResponse("Expected a multipart upload", 400)

    const file = form.get("file")
    const vaultFile = form.get("vault")

    if (!(file instanceof File)) return errorResponse("No document supplied", 400)
    if (file.size === 0) return errorResponse("The document is empty", 400)
    if (file.size > MAX_UPLOAD_BYTES) {
      return errorResponse("The document is too large", 413)
    }
    if (!(vaultFile instanceof File) || vaultFile.size === 0) {
      return errorResponse("No vault supplied", 400)
    }
    if (vaultFile.size > MAX_VAULT_BYTES) {
      return errorResponse("The vault is too large", 413)
    }

    const bytes = new Uint8Array(await file.arrayBuffer())
    const vaultBytes = new Uint8Array(await vaultFile.arrayBuffer())

    const detected = detectDocumentType(bytes, file.name)
    if (!detected) return errorResponse("Unrecognised file type", 415)
    if (!isRestorable(detected.kind)) {
      return errorResponse(
        "A PDF or an image cannot be restored: its pages were rasterised, so the surrogates in it are pixels rather than text. The vault still records what each one stood for.",
        422
      )
    }

    const vault = parseVault(vaultBytes)
    const outcome = await restoreDocument({
      kind: detected.kind,
      bytes,
      vault,
    })

    if (!outcome.ok) return errorResponse(REFUSALS[outcome.reason], 422)

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.restore",
        kind: detected.kind,
        restored: outcome.restored,
        unresolved: outcome.unresolved,
        matchesVault: outcome.matchesVault,
      })
    )

    // Returned as the file rather than as a link. There is nothing stored to
    // link to, and there must not be: a URL serving a restored document is a
    // URL serving the values the export removed.
    return new Response(outcome.bytes as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": detected.mimeType,
        "Content-Disposition": `attachment; filename="${restoredName(file.name, detected.extension)}"`,
        "Cache-Control": "no-store",
        "X-Restored-Values": String(outcome.restored),
        "X-Unresolved-Values": String(outcome.unresolved),
        "X-Vault-Matches": String(outcome.matchesVault),
      },
    })
  } catch (error) {
    if (error instanceof InvalidVaultError || error instanceof InvalidValueKeyError) {
      return errorResponse(error.message, 400)
    }
    return handleRouteError(error, "documents.restore")
  }
}

/** A vault is counts and short strings; anything this size is not one. */
const MAX_VAULT_BYTES = 16 * 1024 * 1024

const REFUSALS: Record<string, string> = {
  "unsupported-format":
    "This format cannot be restored: its pages were rasterised when they were redacted.",
  "nothing-to-restore":
    "Nothing in this document matches the vault. Check that the two came from the same export — and note that pseudonymized values are never reversible.",
  "no-key":
    "The vault has no key for the encrypted values in this document, or the key it has does not open them.",
}

function restoredName(originalName: string, extension: string): string {
  const base = originalName.replace(/\.[^.]+$/, "") || "document"
  const safe = base.replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim()
  return `${safe || "document"}-restored.${extension}`
}
