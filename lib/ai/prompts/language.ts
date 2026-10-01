import { LANGUAGE_NAMES, type Language } from "@/lib/redaction/languages"

/**
 * What the model is told about a document's language.
 *
 * The instructions stay in English for every document. What changes is a
 * section saying what language the content is in and what documents in it
 * look like: the labels that mark a date of birth or a tax number, how an
 * address is written, what the identity numbers are called. Without it the
 * model was asked an English question about German text, and the English
 * examples in the instructions were the only shapes it was pointed at (#43).
 *
 * Nothing for English, which is what the instructions already describe. A
 * language that could not be detected gets nothing either: telling the model
 * a guess as if it were a fact is worse than saying nothing.
 */

const LOOKS_LIKE: Record<Exclude<Language, "en">, string[]> = {
  de: [
    "Names may follow Herr, Frau, Dr. or Prof.",
    "An address is street and number, then postcode and city: Lindenstraße 27, 10969 Berlin.",
    "Dates are written 14.02.1978 or 14. Februar 1978. Geburtsdatum, geb. and geboren am mark a date of birth.",
    "Identity numbers: Steuer-ID (Steuerliche Identifikationsnummer), Personalausweisnummer, Reisepassnummer, Sozialversicherungsnummer, Krankenversichertennummer.",
    "References tied to a person: Kundennummer, Aktenzeichen, Patienten-ID, Versichertennummer.",
    "Bank details: IBAN, Kontonummer, BLZ, BIC.",
  ],
  fr: [
    "Names may follow M., Mme, Dr or Me.",
    "An address is number and street, then postcode and city: 18 rue des Alouettes, 44100 Nantes.",
    "Dates are written 14/03/1987 or 14 mars 1987. Date de naissance, né le and née le mark a date of birth.",
    "Identity numbers: numéro de sécurité sociale (NIR), carte nationale d’identité (CNI), passeport, numéro fiscal, permis de conduire.",
    "References tied to a person: numéro client, référence client, dossier patient, numéro d’adhérent.",
    "Bank details: IBAN, RIB, numéro de compte, BIC.",
  ],
  es: [
    "Names may follow Sr., Sra., D. or Dña., and often carry two surnames.",
    "An address is street, number and floor, then postcode and city: Calle del Mirto 24, 3.º B, 28021 Madrid.",
    "Dates are written 14/02/1987 or 14 de febrero de 1987. Fecha de nacimiento and nacido el or nacida el mark a date of birth.",
    "Identity numbers: DNI, NIE, NIF, pasaporte, número de la Seguridad Social, tarjeta sanitaria.",
    "References tied to a person: número de cliente, identificador de cliente, expediente, número de póliza.",
    "Bank details: IBAN, número de cuenta, BIC.",
  ],
}

/** The section for a detection prompt, or null when there is nothing to add. */
export function languageSection(language: Language | undefined): string | null {
  if (!language || language === "en") return null
  const name = LANGUAGE_NAMES[language]
  return [
    `The content is in ${name}. Read it as ${name} and do not translate it: copy every value exactly as it is written, accents included. Write each reason in English.`,
    `What ${name} documents look like:`,
    ...LOOKS_LIKE[language].map((line) => `- ${line}`),
  ].join("\n")
}

/** The shorter form, for verifying candidates a pattern already found. */
export function languageLine(language: Language | undefined): string | null {
  if (!language || language === "en") return null
  const name = LANGUAGE_NAMES[language]
  return `The document is in ${name}, so the labels in each context are ${name}. Judge the candidate in that language; do not translate it. Write each reason in English.`
}
