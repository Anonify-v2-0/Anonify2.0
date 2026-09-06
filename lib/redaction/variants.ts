import type { RedactionStyle } from "@/lib/documents/image/redact"
import type { MethodOverrides } from "@/lib/redaction/methods"
import { DEFAULT_VARIANT } from "@/lib/redaction/report"
import { REDACTION_METHODS, type RedactionMethod } from "@/types/redaction"

/**
 * More than one output from one review.
 *
 * A reviewer who needs an externally shareable copy with names tokenised and
 * an internal copy with them masked used to have to run the whole review
 * twice. A variant is the smaller thing that makes that unnecessary: the same
 * accepted redactions, exported again with the methods overridden by category.
 * Nothing about *what* was accepted changes between variants — only what
 * happens to the bytes — which is what keeps two artifacts of one review
 * describable by two reports that agree about everything except the methods.
 */

export type VariantSpec = {
  addLabels: boolean
  sanitizeMetadata: boolean
  imageStyle?: RedactionStyle
  /** Methods asked for by category, overriding what each redaction carries. */
  methods?: MethodOverrides
}

export type ExportVariant = VariantSpec & { name: string }

/**
 * How many artifacts one export may produce.
 *
 * Each variant is a full pass over the document — rasterising a PDF, rewriting
 * a package, verifying the result — so this is a bound on work rather than a
 * matter of taste, and a reviewer who wants a fifth output can run the export
 * again.
 */
export const MAX_VARIANTS = 4

/**
 * What a variant is called, derived rather than typed.
 *
 * The name reaches the export report, and the report is the one artifact that
 * must never carry text this pipeline did not choose — see
 * `assertReportOmitsValues`. A reviewer-typed name would be exactly that, and
 * would put a free string on the wrong side of a check that exists to catch
 * free strings. Deriving it from the methods the variant applies keeps the
 * vocabulary closed, and it also names the thing the reader actually needs to
 * know: which of these files is the tokenised one.
 */
const VARIANT_NAMES: Record<RedactionMethod, string> = {
  mask: DEFAULT_VARIANT,
  pseudonymize: "pseudonymized",
  tokenize: "tokenized",
  encrypt: "encrypted",
}

/** Two methods in one variant; the report says which, per category. */
const MIXED = "mixed"

function baseName(spec: VariantSpec): string {
  const methods = new Set(
    Object.values(spec.methods ?? {}).filter(
      (method): method is RedactionMethod =>
        Boolean(method) && method !== "mask"
    )
  )

  if (methods.size === 0) return DEFAULT_VARIANT
  if (methods.size > 1) return MIXED

  const [only] = methods
  return VARIANT_NAMES[only]
}

/**
 * Names each variant, breaking ties by position.
 *
 * Two variants can genuinely deserve the same base name — tokenising names in
 * one and email addresses in the other — so a collision is disambiguated
 * rather than refused. The suffix is an ordinal because there is nothing
 * better to call it that would not be a guess about the reviewer's intent.
 */
export function nameVariants(specs: VariantSpec[]): ExportVariant[] {
  const used = new Map<string, number>()

  return specs.slice(0, MAX_VARIANTS).map((spec) => {
    const base = baseName(spec)
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    return { ...spec, name: seen === 0 ? base : `${base}-${seen + 1}` }
  })
}

/** The single output an export produces when no variants were asked for. */
export function defaultVariant(spec: VariantSpec): ExportVariant {
  return { ...spec, name: DEFAULT_VARIANT }
}

void (REDACTION_METHODS satisfies readonly (keyof typeof VARIANT_NAMES)[])
