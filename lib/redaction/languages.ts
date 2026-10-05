/**
 * Which language a document is written in, and the words that differ by it.
 *
 * The deterministic detectors used to know only English. A German letter has
 * "Geburtsdatum:" where an English one has "DOB:", "Lindenstraße 27, 10969
 * Berlin" where it has "27 Linden Street", and the detectors found the formats
 * they recognised and very little else. Nothing said so: the reviewer got a
 * short list and no sign the tool had only half looked (#43).
 *
 * Latin-script languages only, and only those the synthetic corpus has
 * documents in, so that a change here can be measured rather than assumed.
 * Other scripts are #195.
 *
 * Isomorphic and dependency-free: the detectors, the prompts and the workspace
 * header all read it.
 */

export const LANGUAGES = ["en", "de", "fr", "es"] as const

export type Language = (typeof LANGUAGES)[number]

export const LANGUAGE_NAMES: Record<Language, string> = {
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
}

export function isLanguage(value: unknown): value is Language {
  return (
    typeof value === "string" &&
    (LANGUAGES as readonly string[]).includes(value)
  )
}

export type LanguageGuess = {
  /** What the detectors and prompts are tuned for: the guess, or English. */
  language: Language
  /**
   * False when the text did not say clearly enough, which is not the same as
   * it being English. A Japanese document and a ten-word form both arrive
   * here, and the reviewer should hear that English was assumed, not found.
   */
  detected: boolean
}

/**
 * Short function words, each used by only one of the four languages.
 *
 * Words two of them share are left out on purpose: "de", "la", "que" and "en"
 * are French and Spanish, "des" is French and German, "es" is Spanish and
 * German, "was" and "die" are English and German. Keeping them would let one
 * language's text vote for another.
 */
const MARKERS: Record<Language, ReadonlySet<string>> = {
  en: new Set(
    "the and of to is that with for are this from have not which were been would their they has".split(
      " "
    )
  ),
  de: new Set(
    "der das und ist nicht mit den dem ein eine einen auf für sich auch wird wurde bei nach oder sind zur zum vom wir ihre aus über wie".split(
      " "
    )
  ),
  fr: new Set(
    "le les et est une pour qui dans pas sur au aux avec ce cette sont nous vous été par leur mais où".split(
      " "
    )
  ),
  es: new Set(
    "el los las y del una por con para al lo su sus como más pero está fue este esta ha sobre también".split(
      " "
    )
  ),
}

/** Enough text to tell, and no more: the first pages say what the rest is in. */
const SAMPLE_CHARS = 20_000
/** Fewer marker words than this and the answer is a guess. */
const MIN_HITS = 5
/** How far ahead the winner must be of the runner-up. */
const MARGIN = 2

/**
 * Guesses the language from how often each one's function words appear.
 *
 * Deliberately simple, and deliberately before any model: it runs on an install
 * with no AI configured, costs nothing, and gives the same answer every time.
 * Mixed documents are common (a German letter quoting an English contract
 * clause, a Spanish form with English field names), so it is the majority that
 * decides, and a close call is reported as undetected rather than as a winner.
 */
export function detectLanguage(text: string): LanguageGuess {
  const counts: Record<Language, number> = { en: 0, de: 0, fr: 0, es: 0 }

  for (const match of text.slice(0, SAMPLE_CHARS).matchAll(/\p{L}+/gu)) {
    const word = match[0].toLowerCase()
    for (const language of LANGUAGES) {
      if (MARKERS[language].has(word)) counts[language] += 1
    }
  }

  const [best, second] = [...LANGUAGES].sort((a, b) => counts[b] - counts[a])
  const detected =
    counts[best] >= MIN_HITS && counts[best] >= counts[second] * MARGIN

  return detected
    ? { language: best, detected: true }
    : { language: "en", detected: false }
}

/**
 * The languages whose labels and street formats the detectors should read.
 *
 * Every one of them when the language could not be told. The documents that
 * land there are short forms, CSV exports and logs, which are mostly labels
 * ("Geburtsdatum;IBAN;Kunden-ID"), so reading only English there would lose
 * most of what they hold. The labels are distinct words in each language, so
 * reading them all costs little.
 */
export function detectorLanguages(guess: LanguageGuess): readonly Language[] {
  return guess.detected ? [guess.language] : LANGUAGES
}

/**
 * What the editor says about the language a document was read in, or null
 * when there is nothing worth saying.
 *
 * Detected English is the null: every document was read as English before
 * this existed, and saying it on each of them would be noise. Anything else
 * is said, and an assumption most of all, because it is the case where the
 * reviewer should look harder.
 */
export function describeLanguage(
  read: { language: Language; detected: boolean } | null | undefined
): string | null {
  if (!read) return null
  if (!read.detected) return "language not recognised, read as English"
  if (read.language === "en") return null
  return `read as ${LANGUAGE_NAMES[read.language]}`
}

/** How a label is written in one language, as RegExp source. */
export type LabelVocabulary = {
  birthDate: string
  account: string
  reference: string
  /** Government identity documents and numbers. */
  identity: string
  /**
   * A document's own number: an invoice, a transaction, a company's
   * registration. What follows is not a person's, whatever its shape.
   */
  documentNumber: string
}

/**
 * Labels that come before a value, by language. Matched case-insensitively at
 * the end of the text just before the value; see `labelledBy` in detectors.ts.
 *
 * English is not here: its labels are the detectors' original ones, kept
 * exactly as they were in detectors.ts, and they run for every document,
 * because a German letter with an "IBAN:" line is still German.
 *
 * A reference has to be tied to a person to count: a client, a patient, a
 * policy holder. The bare words, "Referenz", "référence", "dossier",
 * "expediente", label a document's own number at least as often
 * ("Referencia interna: IR-2026-041"), and measured against the corpus they
 * were wrong more often than right.
 */
export const LABELS: Record<Exclude<Language, "en">, LabelVocabulary> = {
  de: {
    birthDate: String.raw`geburtsdatum|geburtstag|geb\.(?:-datum)?|geboren(?:\s+am)?`,
    account: String.raw`konto\S*|bankverbindung|iban|blz`,
    reference: String.raw`kunden(?:nummer|nr\.?|-nr\.?|-id)|aktenzeichen|az\.|fall(?:nummer|-nr\.?)|patienten(?:nummer|-nr\.?|-id)|versicherten(?:nummer|-nr\.?)|mitglieds(?:nummer|-nr\.?)|vorgangs?(?:nummer|-nr\.?)`,
    identity: String.raw`(?:personal)?ausweis(?:nummer|-nr\.?)?|reisepass(?:nummer)?|pass(?:nummer|-nr\.?)|steuer-?id|identifikationsnummer|id-nr\.?|sozialversicherungsnummer|führerschein(?:nummer)?|gesundheitskarte|versicherten-?nr\.?`,
    documentNumber: String.raw`rechnung\S*|referenz|buchung\S*|transaktion\S*|überweisung\S*|ust-?id\S*|handelsregister\S*`,
  },
  fr: {
    birthDate: String.raw`date de naissance|naissance|n[ée]\(?e?\)?\s+le|n[ée]e\s+le`,
    account: String.raw`compte|iban|rib|coordonn[ée]es bancaires`,
    reference: String.raw`client(?:e|es|s)?|patient(?:e|es|s)?|adh[ée]rent(?:e|es|s)?|dossier\s+(?:client|patient|salari[ée])e?|n[°o]\s*(?:de\s+)?police`,
    identity: String.raw`carte nationale d['’]identit[ée]|cni|passeport(?:\s+n°)?|pi[èe]ce d['’]identit[ée]|num[ée]ro fiscal|s[ée]curit[ée] sociale|nir|permis de conduire|id national`,
    documentNumber: String.raw`r[ée]f\.?|r[ée]f[ée]rence|facture|op[ée]ration|transaction|tva|siret|siren`,
  },
  es: {
    birthDate: String.raw`fecha de nacimiento|nacimiento|nacid[oa](?:\s+el)?|f\.\s?nac\.?`,
    account: String.raw`cuenta|iban|ccc`,
    reference: String.raw`client[ea]s?|paciente|caso|p[óo]liza|socio`,
    identity: String.raw`dni|nie|nif|documento(?:\s+nacional)?\s+de\s+identidad|pasaporte|n[uú]mero de documento|permiso de conducir|tarjeta sanitaria|seguridad social`,
    documentNumber: String.raw`factura|referencia|ref\.?|operaci[óo]n|transacci[óo]n|recibo|cif`,
  },
}

/** Month names, for dates written out: "14. Februar 1978", "14 de febrero de 1987". */
export const MONTHS: Record<Language, string[]> = {
  en: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  de: [
    "Januar",
    "Jänner",
    "Februar",
    "März",
    "Maerz",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
  ],
  fr: [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ],
  es: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "setiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
}
