import { z } from "zod"

import {
  errorResponse,
  handleRouteError,
  jsonResponse,
  rateLimitResponse,
} from "@/lib/api/http"
import { exportAndStore } from "@/lib/redaction/deliver"
import { ExportVerificationError } from "@/lib/redaction/export"
import { ReportLeakError } from "@/lib/redaction/report"
import {
  defaultVariant,
  nameVariants,
  MAX_VARIANTS,
  type VariantSpec,
} from "@/lib/redaction/variants"
import { requireDocument } from "@/lib/security/access-control"
import { peekIdentity } from "@/lib/security/fingerprint"
import { consumeRateLimit } from "@/lib/security/rate-limit"
import { createDownloadToken } from "@/lib/security/signed-url"
import { REDACTION_CATEGORIES, REDACTION_METHODS } from "@/types/redaction"

export const runtime = "nodejs"
export const maxDuration = 300

/**
 * Methods asked for by category.
 *
 * Nothing here decides whether the method is *allowed* — that is
 * lib/redaction/methods.ts, asked again at export time — so an override for a
 * mask-only category parses fine and then resolves to a mask. The schema's job
 * is to make sure the strings are ours; the policy's job is to make sure the
 * answer is defensible, and putting both here would give a client two places
 * to be told no.
 */
const methodsSchema = z
  .record(z.enum(REDACTION_CATEGORIES), z.enum(REDACTION_METHODS))
  .optional()

const variantSchema = z.object({
  addLabels: z.boolean().default(false),
  sanitizeMetadata: z.boolean().default(true),
  imageStyle: z.enum(["solid", "blur", "pixelate"]).default("solid"),
  methods: methodsSchema,
})

/**
 * One export, or several.
 *
 * `variants` is how a reviewer gets two outputs from one pass — an internal
 * copy with names masked and a shareable one with them tokenised. Absent, the
 * body is read as a single variant, which is what every existing client sends.
 */
const optionsSchema = variantSchema.extend({
  variants: z.array(variantSchema).min(1).max(MAX_VARIANTS).optional(),
})

/**
 * Generates the redacted document.
 *
 * Deterministic from the accepted redactions, verified against the artifact it
 * just produced, checksummed, stored encrypted, and handed back as a signed
 * short-lived link rather than a storage URL. A verification failure is a
 * refusal to deliver — never a warning attached to a leaking file.
 *
 * The work itself is in lib/redaction/deliver.ts, shared with the batch export
 * so there is one definition of what an export is and one verification gate.
 */
export async function POST(
  request: Request,
  context: RouteContext<"/api/documents/[id]/export">
) {
  try {
    const { id } = await context.params
    const identity = await peekIdentity()

    const limit = await consumeRateLimit(
      "export",
      identity?.networkKey ?? "anonymous"
    )
    if (!limit.allowed) {
      return rateLimitResponse(limit, "exports")
    }

    const document = await requireDocument(id, identity?.ownerKey)
    const options = optionsSchema.parse(await request.json().catch(() => ({})))

    const specs: VariantSpec[] = options.variants ?? []
    const variants =
      specs.length > 0 ? nameVariants(specs) : [defaultVariant(options)]

    const outcome = await exportAndStore(document.id, variants)
    if (!outcome.ok) {
      return errorResponse("Document is not ready", 409)
    }

    const { delivered } = outcome

    console.log(
      JSON.stringify({
        level: "info",
        context: "documents.export",
        documentId: document.id,
        variants: delivered.artifacts.length,
        appliedRedactions: delivered.primary.appliedRedactions,
        checkedValues: delivered.primary.verifiedValues,
        size: delivered.primary.size,
      })
    )

    const described = delivered.artifacts.map((artifact) => {
      const token = createDownloadToken({
        documentId: document.id,
        artifactId: artifact.artifactId,
        ownerKey: document.userFingerprint,
      })

      return {
        artifactId: artifact.artifactId,
        variant: artifact.variant,
        checksum: artifact.checksum,
        size: artifact.size,
        appliedRedactions: artifact.appliedRedactions,
        verifiedValues: artifact.verifiedValues,
        downloadUrl: `/api/documents/${document.id}/download?token=${token}`,
        reportUrl: `/api/documents/${document.id}/download?token=${token}&part=report`,
        report: artifact.report,
        // Handed over inline and stored nowhere. It carries original values and
        // the key that recovers them, so a link to it would be a link to the
        // thing the export exists to remove — and would mean this server had
        // written it down. The browser saves it or it is gone.
        vault: artifact.vault,
      }
    })

    const [primary] = described

    return jsonResponse({
      ...primary,
      metadataSanitized: options.sanitizeMetadata,
      artifacts: described,
    })
  } catch (error) {
    if (error instanceof ExportVerificationError) {
      // Log which values survived for the operator; tell the client only that
      // the export was refused.
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          errorCategory: "verification-failed",
          leakedCount: error.report.leaked.length,
        })
      )
      return errorResponse(
        "The generated document did not pass verification and was not saved.",
        500
      )
    }
    if (error instanceof ReportLeakError) {
      // The report is refused for the same reason a failed export is: it was
      // about to disclose the values it exists to account for.
      console.error(
        JSON.stringify({
          level: "error",
          context: "documents.export",
          errorCategory: "report-leak",
          fields: error.fields,
        })
      )
      return errorResponse(
        "The export report did not pass verification and was not saved.",
        500
      )
    }
    return handleRouteError(error, "documents.export")
  }
}
