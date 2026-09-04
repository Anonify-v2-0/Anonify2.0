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
    Footer,
    Header,
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
        // A name that appears *only* in the header is the case that used to be
        // swept at export but never shown to the reviewer.
        headers: {
          default: new Header({
            children: [
              new Paragraph(`Prepared for ${SENSITIVE.person} - confidential`),
            ],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph(`Contact ${SENSITIVE.email}`)],
          }),
        },
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

/**
 * Builds a workbook with a header row, a formula, a hidden row and a hidden
 * sheet — the places redaction is easiest to get wrong.
 */
export async function makeXlsxFixture(): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = "Test Author"

  const sheet = workbook.addWorksheet("Customers")
  sheet.addRow(["Name", "Email", "Account", "Amount"])
  sheet.addRow([SENSITIVE.person, SENSITIVE.email, SENSITIVE.account, 4000])
  sheet.addRow(["Jane Doe", "jane@example.com", "87654321", 2500])
  sheet.getCell("E2").value = { formula: "B2", result: SENSITIVE.email }
  sheet.getRow(3).hidden = true

  const hidden = workbook.addWorksheet("Archive")
  hidden.state = "hidden"
  hidden.addRow(["Name", "Email"])
  hidden.addRow([SENSITIVE.person, SENSITIVE.email])

  const output = await workbook.xlsx.writeBuffer()
  return new Uint8Array(output)
}

/** Where the fixture's coloured band sits, and the fine detail inside it. */
export const IMAGE_BAND = { x: 40, y: 60, width: 120, height: 40 }
export const IMAGE_DETAIL = { x: 48, y: 68, width: 8, height: 8 }

/**
 * A synthetic image: a white field, a coloured band in a known place, and a
 * small white square of fine detail inside the band. Redaction can then be
 * verified by reading the pixels back rather than by trusting the pipeline.
 */
export async function makeImageFixture(): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default

  const base = await sharp({
    create: {
      width: 400,
      height: 300,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      {
        input: {
          create: {
            width: IMAGE_BAND.width,
            height: IMAGE_BAND.height,
            channels: 3,
            background: { r: 20, g: 40, b: 200 },
          },
        },
        left: IMAGE_BAND.x,
        top: IMAGE_BAND.y,
      },
      {
        input: {
          create: {
            width: IMAGE_DETAIL.width,
            height: IMAGE_DETAIL.height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        },
        left: IMAGE_DETAIL.x,
        top: IMAGE_DETAIL.y,
      },
    ])
    .png()
    .toBuffer()

  return new Uint8Array(base)
}

/** A JPEG carrying EXIF, including a GPS tag. */
export async function makeExifImageFixture(): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default

  const output = await sharp({
    create: {
      width: 200,
      height: 200,
      channels: 3,
      background: { r: 200, g: 120, b: 60 },
    },
  })
    // sharp's Exif typing exposes the numbered IFDs; IFD3 is where it writes
    // the GPS record, so this fixture carries location data too.
    .withExif({
      IFD0: { Copyright: "Test Author", Software: "Anonify Fixture" },
      IFD3: { GPSLatitudeRef: "N", GPSLongitudeRef: "W" },
    })
    .jpeg()
    .toBuffer()

  return new Uint8Array(output)
}
