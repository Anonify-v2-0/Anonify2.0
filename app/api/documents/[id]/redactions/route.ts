import { z } from "zod"

import { errorResponse, handleRouteError, jsonResponse } from "@/lib/api/http"
import { prisma } from "@/lib/database/prisma"
import { newRedactionId } from "@/lib/documents/ids"
import { fromDatabaseRow, toDatabaseRow } from "@/lib/redaction/model"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import {
  REDACTION_SOURCES,
  REDACTION_STATUSES,
  REDACTION_TYPES,
  type Redaction,
} from "@/types/redaction"

export const runtime = "nodejs"

const boundingBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
})

const createSchema = z.object({
  type: z.enum(REDACTION_TYPES),
  source: z.enum(REDACTION_SOURCES).default("user"),
  category: z.string().min(1).max(60),
  status: z.enum(REDACTION_STATUSES).default("accepted"),
  page: z.number().int().positive().optional(),
  text: z.string().max(2000).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  boundingBox: boundingBoxSchema.optional(),
  worksheet: z.string().max(120).optional(),
  row: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  reason: z.string().max(300).optional(),
})

const patchSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(2000),
  status: z.enum(REDACTION_STATUSES),
})

/** Lists the document's redactions, suggestions and accepted alike. */
export async function GET(
  _request: Request,
  context: RouteContext<"/api/documents/[id]/redactions">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    await consumeRateLimit("read", identity?.networkKey ?? "anonymous")

    const document = await requireDocument(id, identity?.ownerKey)

    const rows = await prisma.redaction.findMany({
      where: { documentId: document.id },
      orderBy: [{ page: "asc" }, { startOffset: "asc" }],
    })

    return jsonResponse({ redactions: rows.map(fromDatabaseRow) })
  } catch (error) {
    return handleRouteError(error, "redactions.list")
  }
}

/** Creates a manual redaction: a text selection, a drawn region, a cell. */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/redactions">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    const parsed = createSchema.safeParse(await request.json())
    if (!parsed.success) {
      return errorResponse("Invalid redaction", 400)
    }

    const redaction: Redaction = {
      ...parsed.data,
      id: newRedactionId(),
      documentId: document.id,
    }

    await prisma.redaction.create({ data: toDatabaseRow(redaction) })

    return jsonResponse({ redaction }, 201)
  } catch (error) {
    return handleRouteError(error, "redactions.create")
  }
}

/**
 * Bulk accept or reject. Accepting is the only thing that makes a suggestion
 * count at export time, so it is an explicit, auditable write.
 */
export async function PATCH(
  request: Request,
  context: RouteContext<"/api/documents/[id]/redactions">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    const parsed = patchSchema.safeParse(await request.json())
    if (!parsed.success) {
      return errorResponse("Invalid status change", 400)
    }

    const result = await prisma.redaction.updateMany({
      where: { documentId: document.id, id: { in: parsed.data.ids } },
      data: { status: parsed.data.status },
    })

    return jsonResponse({ updated: result.count })
  } catch (error) {
    return handleRouteError(error, "redactions.update")
  }
}

/** Deletes a redaction outright, for one the user created by mistake. */
export async function DELETE(
  request: Request,
  context: RouteContext<"/api/documents/[id]/redactions">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()
    const document = await requireDocument(id, identity?.ownerKey)

    const url = new URL(request.url)
    const redactionId = url.searchParams.get("redactionId")
    if (!redactionId) return errorResponse("No redaction specified", 400)

    const result = await prisma.redaction.deleteMany({
      where: { documentId: document.id, id: redactionId },
    })

    return jsonResponse({ deleted: result.count })
  } catch (error) {
    return handleRouteError(error, "redactions.delete")
  }
}
