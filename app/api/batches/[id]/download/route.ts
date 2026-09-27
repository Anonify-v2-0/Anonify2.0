import { Readable } from "node:stream"

import { errorResponse, handleRouteError, streamResponse } from "@/lib/api/http"
import { requireBatch } from "@/lib/documents/batches"
import { serializeBatchReport, streamArchive } from "@/lib/redaction/archive"
import {
  assembleBatchDownload,
  NothingToDownloadError,
} from "@/lib/redaction/batch-download"
import {
  DEFAULT_BATCH_OUTPUT,
  isBatchOutput,
} from "@/lib/redaction/batch-layout"
import { peekIdentity } from "@/lib/security/fingerprint"
import { verifyBatchToken } from "@/lib/security/signed-url"

export const runtime = "nodejs"
export const maxDuration = 300

const HEADERS = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
}

function disposition(filename: string): string {
  return `attachment; filename="${filename.replace(/"/g, "")}"`
}

/**
 * A batch, downloaded in the shape the reviewer asked for.
 *
 * `?output=original` gives back what was uploaded, in its own format: a
 * mailbox as a mailbox, rebuilt from its messages' verified exports and
 * verified again as a whole; a message carrying its redacted enclosures; a
 * file as itself. One upload comes back as that one file, several as a zip of
 * them. `?output=processed` is every document's own output in folders that
 * mirror where it came from, and `?output=both` is the two side by side.
 *
 * Nothing is redacted here: the files are the artifacts the export already
 * produced and verified, each re-hashed against the checksum it recorded, and
 * the one thing built — a mailbox — is verified before a byte of it is sent.
 * See lib/redaction/batch-download.ts.
 *
 * `?document=<id>` narrows the download to one top-level upload, which is how
 * the workspace offers a mailbox as the mailbox. `?part=report` serves the
 * batch report for the same download, for the case where the download is a
 * single file with nowhere to put one.
 */
export async function GET(
  request: Request,
  context: RouteContext<"/api/batches/[id]/download">
) {
  try {
    const { id } = await context.params
    const url = new URL(request.url)
    const token = url.searchParams.get("token")
    if (!token) return errorResponse("Missing download token", 401)

    const verified = verifyBatchToken(token)
    if (!verified || verified.batchId !== id) {
      return errorResponse("This download link is invalid or has expired", 401)
    }

    const identity = await peekIdentity()
    const batch = await requireBatch(id, identity?.ownerKey)

    if (verified.ownerKey !== batch.userFingerprint) {
      return errorResponse("This download link is not yours", 403)
    }

    const requested = url.searchParams.get("output")
    if (requested !== null && !isBatchOutput(requested)) {
      return errorResponse("Unknown download format", 400)
    }
    const output = requested ?? DEFAULT_BATCH_OUTPUT

    const download = await assembleBatchDownload(batch.id, {
      output,
      documentId: url.searchParams.get("document"),
    })

    if (url.searchParams.get("part") === "report") {
      return new Response(Buffer.from(serializeBatchReport(download.report)), {
        headers: {
          ...HEADERS,
          "content-type": "application/json",
          "content-disposition": disposition("batch-report.json"),
        },
      })
    }

    if (download.kind === "file") {
      return streamResponse(await download.open(), {
        ...HEADERS,
        "content-type": download.mimeType,
        "content-disposition": disposition(download.filename),
      })
    }

    const archive = Readable.from(streamArchive(download.files), {
      objectMode: false,
    })

    return streamResponse(archive, {
      ...HEADERS,
      "content-type": "application/zip",
      "content-disposition": disposition(download.filename),
    })
  } catch (error) {
    if (error instanceof NothingToDownloadError) {
      return errorResponse(error.message, 409)
    }
    return handleRouteError(error, "batches.download")
  }
}
