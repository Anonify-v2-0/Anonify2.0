import { DOCUMENT_KINDS, type DocumentKind } from "@/types/document"
import {
  DEFAULT_METHOD,
  REDACTION_CATEGORIES,
  REDACTION_METHODS,
  type Redaction,
  type RedactionCategory,
  type RedactionMethod,
} from "@/types/redaction"

/**
 * Which method a redaction may be given.
 *
 * Two gates, and both have to open. The first is the category: a value's kind
 * decides whether anything softer than removal is defensible at all, and for
 * the categories where removal is the entire point there is no softer option
 * to be had. The second is capability: a method other than `mask` has to
 * actually put a surrogate somewhere, and a redaction that covers no text —
 * a face, a whole column, a region with nothing recognised behind it — has
 * nowhere to put one. Masking is not the *default* in those cases, it is the
 * only thing that exists.
 *
 * The alternative would have been to let the reviewer choose a method and
 * quietly fall back to masking where it could not be honoured. That is the
 * failure mode this file exists to prevent: a reviewer who picked "tokenize"
 * and got a black box has been told something untrue about their document.
 * `methodsFor()` is asked before the choice is offered, and `resolveMethod()`
 * is asked again at export time, so the two cannot drift.
 */

/**
 * Category → the methods it may be given.
 *
 * `mask` is in every row, and is the only entry for the five where a reversible
 * or joinable form would defeat the redaction. A pseudonymised government ID is
 * still a government ID under a different name — the pseudonym joins the same
 * records the number did — and a face has no textual form to replace at all.
 *
 * `address` and `date-of-birth` take `encrypt` but not the two surrogate
 * methods, and the distinction is deliberate: an encrypted value is opaque,
 * while a stable surrogate for a birth date or a street address is a
 * quasi-identifier that re-identifies by joining against anything else in the
 * file. Encryption keeps the field's position without keeping its power to
 * link.
 */
const CATEGORY_METHODS: Record<RedactionCategory, readonly RedactionMethod[]> = {
  person: ["mask", "pseudonymize", "tokenize", "encrypt"],
  email: ["mask", "pseudonymize", "tokenize", "encrypt"],
  phone: ["mask", "pseudonymize", "tokenize", "encrypt"],
  "customer-id": ["mask", "pseudonymize", "tokenize", "encrypt"],
  url: ["mask", "pseudonymize", "tokenize", "encrypt"],
  address: ["mask", "encrypt"],
  "date-of-birth": ["mask", "encrypt"],
  "government-id": ["mask"],
  "bank-account": ["mask"],
  financial: ["mask"],
  "api-key": ["mask"],
  face: ["mask"],
  confidential: ["mask"],
  other: ["mask"],
}

/**
 * How a format can carry a surrogate where a value used to be.
 *
 * `text` means the bytes hold characters this pipeline can rewrite in place:
 * the surrogate goes exactly where the value was, in a form the next program
 * to open the file can read, search and parse.
 *
 * `raster` means it cannot. A PDF page carrying a redaction is rendered to
 * pixels — that is what makes a PDF redaction real rather than a rectangle
 * drawn over recoverable glyphs — and an image never had a text layer to
 * begin with. There is still somewhere to put a surrogate, though: the strip
 * that covers the value is a rectangle this pipeline drew, and it can be
 * drawn with text on it. That is the whole bypass, and it is why a scanned
 * contract or a photographed form gets the same vocabulary as a DOCX rather
 * than being told masking is all it can have.
 *
 * The one thing a strip cannot carry is a long string, so a raster surrogate
 * is always the short form — see `usesShortSurrogate()`.
 */
export type SurrogateCarrier = "text" | "raster"

const CARRIER: Record<DocumentKind, SurrogateCarrier> = {
  pdf: "raster",
  image: "raster",
  docx: "text",
  pptx: "text",
  xlsx: "text",
  csv: "text",
  tsv: "text",
  txt: "text",
  rtf: "text",
  eml: "text",
}

export function surrogateCarrier(kind: DocumentKind): SurrogateCarrier {
  return CARRIER[kind]
}

/**
 * Redaction types that address a position rather than a value.
 *
 * A row or a column redaction's `text` is the column's *header*, which the
 * exporter keeps on purpose — see `acceptedValues()` in model.ts. There is no
 * value to substitute, only fields to empty, so these are masked whatever the
 * category says.
 */
const POSITIONAL_TYPES = new Set<Redaction["type"]>(["row", "column"])

/** Shortest value worth substituting; below this a surrogate is longer noise. */
const MIN_SUBSTITUTABLE_LENGTH = 2

/**
 * Whether this redaction covers text a surrogate could replace.
 *
 * A face is the clear case — there is no string under it — but the quiet one
 * is a bounding-box region on an image where OCR found nothing. Both are
 * regions, both look identical in the model, and only one of them has a value
 * to pseudonymise. The presence of `text` is what separates them.
 */
export function carriesSubstitutableText(redaction: Redaction): boolean {
  if (redaction.type === "face") return false
  if (POSITIONAL_TYPES.has(redaction.type)) return false
  const text = redaction.text?.trim()
  return Boolean(text && text.length >= MIN_SUBSTITUTABLE_LENGTH)
}

/**
 * Every method this redaction may be given, in this document.
 *
 * Always contains `mask`, so there is never an empty menu, and the UI offers
 * exactly this list rather than filtering a longer one of its own.
 */
export function methodsFor(redaction: Redaction): RedactionMethod[] {
  if (!carriesSubstitutableText(redaction)) return [DEFAULT_METHOD]
  return [...CATEGORY_METHODS[asCategory(redaction.category)]]
}

/**
 * Whether a surrogate for this redaction has to be the short, painted form.
 *
 * True on a raster target, where the surrogate is drawn into a rectangle the
 * width of the value it replaced. An encrypted value's ciphertext does not fit
 * there and would not survive being read back off the page, so the strip gets
 * a reference and the vault gets the ciphertext.
 */
export function usesShortSurrogate(kind: DocumentKind): boolean {
  return CARRIER[kind] === "raster"
}

export function isMethodAllowed(
  method: RedactionMethod,
  redaction: Redaction
): boolean {
  return methodsFor(redaction).includes(method)
}

/**
 * A method asked for by category, overriding what each redaction carries.
 *
 * This is what makes two artifacts out of one review: a variant that names
 * `{ person: "tokenize" }` tokenises every accepted name, whatever the
 * inspector recorded against each one, and a variant that names nothing
 * exports what the reviewer chose. An override is not a way around the table
 * above — it goes through `resolveMethod()` like everything else, so asking
 * for a tokenised face still produces a mask.
 */
export type MethodOverrides = Partial<Record<RedactionCategory, RedactionMethod>>

/**
 * The method this redaction is exported with.
 *
 * Asked at export time, not read from the record: a method that was valid when
 * it was chosen and is not valid now — the category was corrected, the OCR
 * that gave a region its text was re-run and found nothing — resolves to
 * `mask` rather than to a substitution that cannot be made. Falling back to
 * removal is always safe; falling back the other way never is.
 */
export function resolveMethod(
  redaction: Redaction,
  overrides: MethodOverrides = {}
): RedactionMethod {
  const requested =
    overrides[asCategory(redaction.category)] ?? redaction.method
  if (!requested || requested === DEFAULT_METHOD) return DEFAULT_METHOD
  return isMethodAllowed(requested, redaction) ? requested : DEFAULT_METHOD
}

/** Methods that need the reviewer to be handed something to reverse them. */
const VAULTED_METHODS = new Set<RedactionMethod>(["tokenize", "encrypt"])

export function needsVault(method: RedactionMethod): boolean {
  return VAULTED_METHODS.has(method)
}

const CATEGORIES = new Set<string>(REDACTION_CATEGORIES)

/**
 * A category is a free string in the database, because a model can return
 * whatever it likes. An unrecognised one gets `other`'s policy, which is
 * mask-only — the safe reading of "we do not know what this is".
 */
function asCategory(category: string): RedactionCategory {
  return (CATEGORIES.has(category) ? category : "other") as RedactionCategory
}

export function isRedactionMethod(value: unknown): value is RedactionMethod {
  return (
    typeof value === "string" &&
    (REDACTION_METHODS as readonly string[]).includes(value)
  )
}

/** Every kind is in the carrier table; a new one has to say which it is. */
void (DOCUMENT_KINDS satisfies readonly (keyof typeof CARRIER)[])
