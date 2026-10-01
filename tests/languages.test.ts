import { describe, expect, it } from "vitest"

import { languageLine, languageSection } from "@/lib/ai/prompts/language"
import { detectPiiPrompt } from "@/lib/ai/prompts/detect-pii"
import { verifyDetectionPrompt } from "@/lib/ai/prompts/verify-detection"
import { documentLanguage } from "@/lib/ai/analyze"
import {
  detectPatterns,
  passesDniCheck,
  passesIbanCheck,
  passesNirCheck,
  passesSteuerIdCheck,
} from "@/lib/redaction/detectors"
import {
  describeLanguage,
  detectLanguage,
  detectorLanguages,
  LANGUAGES,
  type Language,
} from "@/lib/redaction/languages"

/**
 * Reading a document in its own language (#43).
 *
 * The detectors used to know English only, so a German letter got its email
 * addresses found and very little else, and nothing said the tool had only
 * half looked. The values below are shaped like the synthetic corpus's, which
 * is what these changes were measured against.
 */

const GERMAN = `Sehr geehrte Frau Voss,

wir bestätigen den Eingang Ihrer Unterlagen und haben die Angaben mit der Akte
abgeglichen. Die Erstattung wird auf das Konto überwiesen, das Sie uns genannt
haben, und wir melden uns bei Rückfragen.`

const FRENCH = `Madame,

Nous avons bien reçu votre dossier et nous vous remercions pour les pièces
transmises. Le remboursement sera effectué sur le compte que vous avez indiqué
dans votre courrier, et nous restons à votre disposition pour toute question.`

const SPANISH = `Estimada señora:

Hemos recibido su solicitud y la documentación que nos envió por correo. El
reembolso se hará a la cuenta que indicó en su carta, y le escribiremos si
necesitamos algún dato más sobre el expediente.`

const ENGLISH = `Dear Ms Voss,

Thank you for sending the documents. We have checked them against the file and
the refund will be paid to the account that you gave us, which is the one on
record for this claim.`

function found(text: string, languages: readonly Language[]) {
  return detectPatterns(text, { languages }).map((d) => [d.category, d.text])
}

describe("telling the language", () => {
  it.each([
    ["en", ENGLISH],
    ["de", GERMAN],
    ["fr", FRENCH],
    ["es", SPANISH],
  ] as const)("reads %s prose as that language", (language, text) => {
    expect(detectLanguage(text)).toEqual({ language, detected: true })
  })

  it("assumes English, and says it assumed, when there is too little to go on", () => {
    expect(
      detectLanguage("Name;IBAN;Telefon\nMaren Vogt;DE89…;030 1234")
    ).toEqual({ language: "en", detected: false })
    // A close call is not a winner either.
    expect(detectLanguage(`${ENGLISH}\n${GERMAN}`).detected).toBe(false)
  })

  it("does not take a script it does not know for English", () => {
    expect(
      detectLanguage(
        "お問い合わせありがとうございます。担当者よりご連絡いたします。"
      )
    ).toEqual({
      language: "en",
      detected: false,
    })
  })

  it("reads every language's labels when the language could not be told", () => {
    expect(detectorLanguages({ language: "de", detected: true })).toEqual([
      "de",
    ])
    expect(detectorLanguages({ language: "en", detected: false })).toEqual(
      LANGUAGES
    )
  })

  it("reads a spreadsheet's language from its cells", () => {
    const cells = GERMAN.split(" ").map((value, index) => ({
      row: 2,
      column: index + 1,
      value,
    }))
    expect(
      documentLanguage({
        documentId: "doc_1",
        kind: "xlsx",
        pages: [],
        sheets: [
          {
            name: "Tabelle1",
            headers: [],
            rowCount: 2,
            columnCount: cells.length,
            cells,
          },
        ],
      } as never)
    ).toEqual({ language: "de", detected: true })
  })
})

describe("German documents", () => {
  const de = ["de"] as const

  it("finds dates of birth by their German labels", () => {
    expect(found("Geburtsdatum: 14.02.1978", de)).toContainEqual([
      "date-of-birth",
      "14.02.1978",
    ])
    expect(found("Mara Feldner, geb. 14.02.1978, wohnhaft", de)).toContainEqual(
      ["date-of-birth", "14.02.1978"]
    )
    expect(found("Zur Zuordnung: geboren am 14. März 1988", de)).toContainEqual(
      ["date-of-birth", "14. März 1988"]
    )
    // English alone reads past the German label, which is the bug.
    expect(found("Geburtsdatum: 14.02.1978", ["en"])).toEqual([])
  })

  it("finds a street with its postcode and city", () => {
    expect(
      found("Anschrift: Lindenstraße 27, 10969 Berlin", de)
    ).toContainEqual(["address", "Lindenstraße 27, 10969 Berlin"])
    expect(
      found("Anschrift: Am Mühlenbogen 17, 45127 Essen", de)
    ).toContainEqual(["address", "Am Mühlenbogen 17, 45127 Essen"])
  })

  it("finds references, accounts and identity numbers by their labels", () => {
    expect(found("Kundennummer: KD-4817-29", de)).toContainEqual([
      "customer-id",
      "KD-4817-29",
    ])
    expect(found("Personalausweisnummer V59H7Z2F0", de)).toContainEqual([
      "government-id",
      "V59H7Z2F0",
    ])
    expect(found("Kontonummer: 3608253128", de)).toContainEqual([
      "bank-account",
      "3608253128",
    ])
  })

  it("finds a Steuer-ID by its check digit, and not a number that fails it", () => {
    expect(passesSteuerIdCheck("49 782 584 941")).toBe(true)
    expect(passesSteuerIdCheck("49 782 584 942")).toBe(false)
    expect(found("Die Nummer 49 782 584 941 liegt vor", de)).toContainEqual([
      "government-id",
      "49 782 584 941",
    ])
    // Only where German is likely: one number in ten passes by chance.
    expect(
      found("The number 49 782 584 941 is on file", ["en"])
    ).not.toContainEqual(["government-id", "49 782 584 941"])
  })

  it("reads German telephone formats", () => {
    expect(found("Telefon: 040/66969201", de)).toContainEqual([
      "phone",
      "040/66969201",
    ])
    expect(found("Tel. +49 (0)40 66969 166", de)).toContainEqual([
      "phone",
      "+49 (0)40 66969 166",
    ])
  })
})

describe("French documents", () => {
  const fr = ["fr"] as const

  it("finds dates of birth by their French labels, numeric or written out", () => {
    expect(found("Née le : 14/03/1987", fr)).toContainEqual([
      "date-of-birth",
      "14/03/1987",
    ])
    expect(
      found("Date de naissance déclarée : 14 septembre 1987", fr)
    ).toContainEqual(["date-of-birth", "14 septembre 1987"])
  })

  it("finds a street written number first", () => {
    expect(
      found("Adresse : 18 rue des Alouettes, 44100 Nantes", fr)
    ).toContainEqual(["address", "18 rue des Alouettes, 44100 Nantes"])
    expect(
      found("au courrier : 7, allée du Clos-Neuf, 35000 Rennes", fr)
    ).toContainEqual(["address", "7, allée du Clos-Neuf, 35000 Rennes"])
  })

  it("reads a French telephone number in pairs", () => {
    expect(found("Tél. : 02 61 91 55 99", fr)).toContainEqual([
      "phone",
      "02 61 91 55 99",
    ])
    expect(found("Téléphone : +33 1 99 00 15 77", fr)).toContainEqual([
      "phone",
      "+33 1 99 00 15 77",
    ])
  })

  it("finds a social security number by its key", () => {
    const body = "1850578006084"
    const key = String(97 - Number(BigInt(body) % BigInt(97))).padStart(2, "0")
    const nir = `1 85 05 78 006 084 ${key}`
    expect(passesNirCheck(nir)).toBe(true)
    expect(
      passesNirCheck(`1 85 05 78 006 084 ${key === "01" ? "02" : "01"}`)
    ).toBe(false)
    expect(found(`Assuré : ${nir}`, fr)).toContainEqual(["government-id", nir])
  })

  it("takes a client number, and not a document's own reference", () => {
    expect(found("N° client : CL-804291", fr)).toContainEqual([
      "customer-id",
      "CL-804291",
    ])
    expect(found("Référence interne : IR-2026-041", fr)).toEqual([])
  })
})

describe("Spanish documents", () => {
  const es = ["es"] as const

  it("finds dates of birth by their Spanish labels", () => {
    expect(found("Fecha de nacimiento: 14/02/1987", es)).toContainEqual([
      "date-of-birth",
      "14/02/1987",
    ])
    expect(found("nacida el 14 de febrero de 1987", es)).toContainEqual([
      "date-of-birth",
      "14 de febrero de 1987",
    ])
  })

  it("finds a street with its floor, postcode and city", () => {
    expect(
      found("Domicilio: Calle del Mirto 24, 3.º B, 28021 Madrid", es)
    ).toContainEqual(["address", "Calle del Mirto 24, 3.º B, 28021 Madrid"])
    expect(
      found("La ficha conserva plaza de la Encina, 8, bajo, 41003 Sevilla", es)
    ).toContainEqual(["address", "plaza de la Encina, 8, bajo, 41003 Sevilla"])
  })

  it("finds a DNI or NIE by its check letter", () => {
    expect(passesDniCheck("86153070S")).toBe(true)
    expect(passesDniCheck("86153070T")).toBe(false)
    expect(passesDniCheck("Z3184554W")).toBe(true)
    expect(found("Su documento es 86153070S.", es)).toContainEqual([
      "government-id",
      "86153070S",
    ])
  })

  it("takes a client number, and not a document's own reference", () => {
    expect(found("Identificador de cliente: CL-ES-740019", es)).toContainEqual([
      "customer-id",
      "CL-ES-740019",
    ])
    expect(found("Referencia interna: IR-2026-041", es)).toEqual([])
  })
})

describe("IBANs printed in groups", () => {
  it("finds one with valid check digits, whatever the country", () => {
    expect(passesIbanCheck("DE89 3704 0044 0532 0130 00")).toBe(true)
    expect(found("IBAN: DE89 3704 0044 0532 0130 00", ["en"])).toEqual([
      ["bank-account", "DE89 3704 0044 0532 0130 00"],
    ])
  })

  it("leaves out a spaced one whose check digits fail", () => {
    expect(passesIbanCheck("DE89 3704 0044 0532 0130 01")).toBe(false)
    expect(
      found("IBAN: DE89 3704 0044 0532 0130 01", ["en"]).filter(
        ([category]) => category === "bank-account"
      )
    ).toEqual([])
  })

  it("does not take a capitalised word after it as part of the number", () => {
    expect(
      found("IBAN DE89 3704 0044 0532 0130 00 BITTE PRÜFEN", ["de"])
    ).toContainEqual(["bank-account", "DE89 3704 0044 0532 0130 00"])
  })
})

describe("saying which language was assumed", () => {
  it("says nothing for English, which is what everything was read as before", () => {
    expect(describeLanguage({ language: "en", detected: true })).toBeNull()
    expect(describeLanguage(null)).toBeNull()
  })

  it("names a detected language, and says so when it had to assume", () => {
    expect(describeLanguage({ language: "fr", detected: true })).toBe(
      "read as French"
    )
    expect(describeLanguage({ language: "en", detected: false })).toBe(
      "language not recognised, read as English"
    )
  })
})

describe("the prompts", () => {
  it("tells the model the language and what its documents look like", () => {
    const prompt = detectPiiPrompt({ content: "…", language: "de" })
    expect(prompt).toContain("The content is in German")
    expect(prompt).toContain("Geburtsdatum")
    expect(prompt).toContain("do not translate it")
    // Before the content, so it is read as an instruction and not as text.
    expect(prompt.indexOf("German")).toBeLessThan(prompt.indexOf("CONTENT:"))
  })

  it("adds nothing for English or for a language it could not tell", () => {
    expect(languageSection("en")).toBeNull()
    expect(languageSection(undefined)).toBeNull()
    expect(detectPiiPrompt({ content: "…" })).not.toContain("The content is in")
  })

  it("gives the verification call the language in one line", () => {
    const candidates = [
      {
        index: 0,
        text: "3608253128",
        category: "bank-account",
        context: "Konto",
      },
    ]
    expect(verifyDetectionPrompt(candidates, "es")).toContain(
      languageLine("es")!
    )
    expect(verifyDetectionPrompt(candidates)).toMatch(/^CANDIDATES:/)
  })
})
