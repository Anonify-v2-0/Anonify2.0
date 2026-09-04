import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

/** Text used across the redaction-correctness suites. */
export const SENSITIVE = {
  person: "John Smith",
  email: "john@example.com",
  phone: "+1 (415) 555-0132",
  account: "12345678",
} as const

export type FixtureLine = { text: string; size?: number }

/**
 * Builds a small, real PDF so extraction and export are exercised against an
 * actual file rather than a mock.
 */
export async function makePdfFixture(
  pages: FixtureLine[][] = [
    [
      { text: `${SENSITIVE.person} works at Example Corporation.` },
      { text: `Email: ${SENSITIVE.email}` },
      { text: `Phone: ${SENSITIVE.phone}` },
    ],
  ]
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  for (const lines of pages) {
    const page = pdf.addPage([612, 792])
    let y = 720
    for (const line of lines) {
      const size = line.size ?? 12
      page.drawText(line.text, {
        x: 72,
        y,
        size,
        font,
        color: rgb(0, 0, 0),
      })
      y -= size * 2
    }
  }

  return pdf.save()
}

/** A PDF with no extractable text, standing in for a scanned document. */
export async function makeScannedPdfFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 792])
  page.drawRectangle({
    x: 72,
    y: 600,
    width: 200,
    height: 80,
    color: rgb(0.85, 0.85, 0.85),
  })
  return pdf.save()
}

/**
 * Builds a DOCX with headings, styled runs and a table so extraction and export
 * are exercised against real OOXML.
 */
export async function makeDocxFixture(): Promise<Uint8Array> {
  const {
    Document,
    HeadingLevel,
    Packer,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
  } = await import("docx")

  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            text: "Client Report",
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [
              new TextRun({ text: `${SENSITIVE.person} `, bold: true }),
              new TextRun({ text: "works at Example Corporation." }),
            ],
          }),
          new Paragraph({
            children: [
              new TextRun({ text: "Email: " }),
              new TextRun({ text: SENSITIVE.email, italics: true }),
            ],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph("Name")] }),
                  new TableCell({ children: [new Paragraph("Account")] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph(SENSITIVE.person)] }),
                  new TableCell({
                    children: [new Paragraph(SENSITIVE.account)],
                  }),
                ],
              }),
            ],
          }),
        ],
      },
    ],
  })

  const buffer = await Packer.toBuffer(doc)
  return new Uint8Array(buffer)
}
