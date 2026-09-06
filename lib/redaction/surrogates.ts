import {
  normalizeValue,
  type ValueReplacement,
} from "@/lib/documents/shared/text"
import { isAccepted } from "@/lib/redaction/model"
import {
  carriesSubstitutableText,
  resolveMethod,
  usesShortSurrogate,
  type MethodOverrides,
} from "@/lib/redaction/methods"
import {
  encryptValue,
  inlineCiphertext,
  newValueKey,
  type VaultEntry,
} from "@/lib/redaction/vault"
import type { DocumentKind } from "@/types/document"
import {
  DEFAULT_METHOD,
  type Redaction,
  type RedactionCategory,
  type RedactionMethod,
} from "@/types/redaction"

/**
 * Deciding what stands in for each accepted value.
 *
 * The unit here is the *value*, not the redaction, and that is the one design
 * decision in this file worth arguing about. A method is chosen per redaction
 * in the inspector, but a document does not contain redactions — it contains
 * occurrences of a string, some of which a reviewer looked at and some of
 * which are in a hidden sheet, a speaker note or a quoted reply that the
 * safety sweep will find on its own. If the same name were pseudonymised where
 * it was reviewed and masked where it was swept, the export would silently
 * break the join the pseudonym existed to preserve, and the reviewer would
 * have no way to see that from the file.
 *
 * So every occurrence of a value gets the same treatment, and where the
 * redactions covering a value disagree, the strongest of them wins — see
 * `strongest()`. Masking something the reviewer asked to pseudonymise costs
 * them a pseudonym; the other direction substitutes where they asked to
 * remove, and that is not a trade this pipeline gets to make.
 */

/** Strongest first. The first method present in a value's redactions wins. */
const STRENGTH: RedactionMethod[] = [
  // Irreversible by anyone.
  "mask",
  // Irreversible, but the same value maps to the same surrogate, so equality
  // survives — which is information, and puts it below removal.
  "pseudonymize",
  // Reversible by the key holder. Above tokenize because the artifact that
  // reverses it is a key rather than a list of the values themselves.
  "encrypt",
  "tokenize",
]

function strongest(methods: RedactionMethod[]): RedactionMethod {
  for (const method of STRENGTH) {
    if (methods.includes(method)) return method
  }
  return DEFAULT_METHOD
}

/**
 * The stem a category's surrogates are numbered from.
 *
 * Named for the kind of value, not for the category's spelling, because these
 * strings end up in the reviewer's document: `CUSTOMER_014` reads as something
 * a system would produce and `CUSTOMER-ID_014` reads as a bug.
 */
const STEMS: Partial<Record<RedactionCategory, string>> = {
  person: "PERSON",
  email: "EMAIL",
  phone: "PHONE",
  "customer-id": "CUSTOMER",
  url: "URL",
  address: "ADDRESS",
  "date-of-birth": "DOB",
}

/** The stem for a surrogate that stands in for a ciphertext, not a value. */
const CIPHER_STEM = "ENC"

const SURROGATE_DIGITS = 3

function surrogateName(stem: string, ordinal: number): string {
  return `${stem}_${String(ordinal).padStart(SURROGATE_DIGITS, "0")}`
}

export type Surrogates = {
  /** What replaces this redaction's characters, or undefined to mask them. */
  forRedaction(redaction: Redaction): string | undefined
  /** The same, for a value the safety sweep found rather than an addressed one. */
  forValue(value: string): string | undefined
  /** Accepted values and their replacements, for the package-wide sweep. */
  readonly values: ValueReplacement[]
  /** The method each accepted redaction was actually exported with. */
  methodOf(redaction: Redaction): RedactionMethod
  /** What the reviewer has to be handed to reverse any of this. */
  readonly vaultEntries: VaultEntry[]
  /** The value key, present only when something was encrypted. */
  readonly key: Buffer | null
  /**
   * Every string this book put into the document.
   *
   * The export verifier searches the artifact for accepted values, and a
   * surrogate is text this pipeline authored rather than text the document
   * had. Handing the verifier the list lets it take them out of the haystack
   * before it looks, so a base64url ciphertext that happens to contain the
   * four letters of a short accepted value cannot fail an export that is
   * perfectly correct.
   */
  readonly substitutions: string[]
}

/**
 * The book an export makes when nothing was substituted.
 *
 * Every plan builder falls back to this, so a caller that knows only about
 * masking — every test of a per-format redactor, and every export taken before
 * methods existed — behaves exactly as it did.
 */
export const NO_SURROGATES: Surrogates = {
  forRedaction: () => undefined,
  forValue: () => undefined,
  values: [],
  methodOf: () => DEFAULT_METHOD,
  vaultEntries: [],
  key: null,
  substitutions: [],
}

/**
 * Works out every substitution one export will make.
 *
 * Deterministic given the same redactions in the same order, apart from the
 * ciphertexts — a fresh IV per value is what stops `encrypt` from leaking
 * equality, so two runs of the same export produce different encrypted bytes
 * and the same everything else.
 */
export function buildSurrogates(
  redactions: Redaction[],
  kind: DocumentKind,
  options: {
    /** The variant's per-category overrides, if it named any. */
    overrides?: MethodOverrides
    /**
     * A key to encrypt under, rather than one generated here.
     *
     * A message and its attachments are exported separately and delivered
     * together, so they have to share a key: handing the reviewer three keys
     * for one download would be three chances to lose the one that mattered.
     * The key is only *reported* if something was actually encrypted with it.
     */
    key?: Buffer
  } = {}
): Surrogates {
  const overrides = options.overrides ?? {}
  const accepted = redactions.filter(isAccepted)

  // Grouped by folded value, which is how the sweep matches too: the same name
  // with different capitalisation in a header and a body is one value.
  const groups = new Map<string, { display: string; methods: RedactionMethod[]; category: string }>()

  for (const redaction of accepted) {
    // The same filter `acceptedValues()` applies, and for the reason it gives:
    // a column redaction's text is the header the exporter keeps on purpose,
    // so sweeping for it asks the export to remove a string it was told to
    // preserve. A redaction that fails this is masked in place and contributes
    // no value.
    if (!carriesSubstitutableText(redaction)) continue
    const text = redaction.text?.trim()
    if (!text) continue
    const method = resolveMethod(redaction, overrides)
    const folded = normalizeValue(text)

    const group = groups.get(folded)
    if (group) {
      group.methods.push(method)
    } else {
      groups.set(folded, {
        display: text,
        methods: [method],
        category: redaction.category,
      })
    }
  }

  const shortForm = usesShortSurrogate(kind)
  const counters = new Map<string, number>()
  const byValue = new Map<string, string>()
  const methodByValue = new Map<string, RedactionMethod>()
  const vaultEntries: VaultEntry[] = []
  const values: ValueReplacement[] = []
  const substitutions: string[] = []
  // Non-null only once something has been encrypted with it, so a supplied
  // key that went unused is not handed back as though it opened something.
  let key: Buffer | null = null

  const nextName = (stem: string) => {
    const ordinal = (counters.get(stem) ?? 0) + 1
    counters.set(stem, ordinal)
    return surrogateName(stem, ordinal)
  }

  // Sorted so the numbering is stable across runs: a Map preserves insertion
  // order, and insertion order here is the order the database happened to
  // return rows in.
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))

  for (const [folded, group] of ordered) {
    const method = strongest(group.methods)
    methodByValue.set(folded, method)

    if (method === DEFAULT_METHOD) {
      // Left undefined rather than set to the label: a mask is the plan's
      // label, decided by the export options, and a range with no replacement
      // is what says so. It is also what makes a mask win a merge.
      values.push({ value: group.display })
      continue
    }

    const stem = STEMS[group.category as RedactionCategory] ?? "VALUE"
    let replacement: string

    if (method === "encrypt") {
      key ??= options.key ?? newValueKey()
      const ciphertext = encryptValue(group.display, key)

      if (shortForm) {
        // A rasterised page has room for a reference and not for a ciphertext.
        // The strip carries the name; the vault carries what it stands for.
        replacement = nextName(CIPHER_STEM)
        vaultEntries.push({
          method: "encrypt",
          surrogate: replacement,
          category: group.category,
          ciphertext,
        })
      } else {
        replacement = inlineCiphertext(ciphertext)
      }
    } else {
      replacement = nextName(stem)
      if (method === "tokenize") {
        vaultEntries.push({
          method: "tokenize",
          surrogate: replacement,
          category: group.category,
          value: group.display,
        })
      }
    }

    byValue.set(folded, replacement)
    values.push({ value: group.display, replacement })
    substitutions.push(replacement)
  }

  if (values.length === 0) return NO_SURROGATES

  return {
    forRedaction(redaction) {
      const text = redaction.text?.trim()
      if (!text) return undefined
      return byValue.get(normalizeValue(text))
    },
    forValue(value) {
      return byValue.get(normalizeValue(value))
    },
    values,
    methodOf(redaction) {
      const text = redaction.text?.trim()
      if (!text) return DEFAULT_METHOD
      return methodByValue.get(normalizeValue(text)) ?? DEFAULT_METHOD
    },
    vaultEntries,
    key,
    substitutions,
  }
}
