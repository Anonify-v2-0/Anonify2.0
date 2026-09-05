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

/**
 * A PDF with a real embedded raster image on page two.
 *
 * Not a drawn rectangle: a vector fill is not an image, and the point of this
 * fixture is the distinction the extractor has to make — which pages are worth
 * showing to a vision model, because a face or a signature lives in pixels that
 * no text detector can see.
 */
export async function makeImagePdfFixture(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)

  const textPage = pdf.addPage([612, 792])
  textPage.drawText("Page one carries only text.", {
    x: 72,
    y: 700,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  })

  const png = await pdf.embedPng(await makeImageFixture())
  const imagePage = pdf.addPage([612, 792])
  imagePage.drawText("Page two carries a photograph.", {
    x: 72,
    y: 700,
    size: 12,
    font,
    color: rgb(0, 0, 0),
  })
  imagePage.drawImage(png, { x: 72, y: 400, width: 200, height: 150 })

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

/**
 * A workbook whose used range is mostly empty.
 *
 * One value out at the far edge is enough to make ExcelJS report a used range
 * of hundreds of cells, almost all of them blank. Quota accounting has to
 * charge for what is actually there — the blanks are neither work to process
 * nor anything that could leak.
 */
export async function makeSparseXlsxFixture(): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default
  const workbook = new ExcelJS.Workbook()

  const sheet = workbook.addWorksheet("Sparse")
  sheet.getCell("A1").value = "Name"
  sheet.getCell("B1").value = "Email"
  sheet.getCell("A2").value = SENSITIVE.person
  sheet.getCell("B2").value = SENSITIVE.email
  // Far out to the right and a long way down, which is what stretches the
  // used range without adding any content worth charging for.
  sheet.getCell("Z40").value = "stray"

  const output = await workbook.xlsx.writeBuffer()
  return new Uint8Array(output)
}

/**
 * A long document with no explicit page breaks — which is what almost every
 * real DOCX is, and the case that used to collapse into a single endless page.
 * `breakAfter` inserts a hard break after that paragraph index when given.
 */
export async function makeLongDocxFixture(
  paragraphs = 120,
  breakAfter?: number
): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, TextRun } = await import("docx")

  const body = Array.from({ length: paragraphs }, (_, index) => {
    const runs = [
      new TextRun(
        `Paragraph ${index + 1}. ` +
          "This sentence exists to take up a predictable amount of space on the " +
          "page so pagination has something to measure. "
      ),
    ]
    return new Paragraph({
      children: runs,
      ...(breakAfter !== undefined && index === breakAfter
        ? { pageBreakBefore: false }
        : {}),
    })
  })

  if (breakAfter !== undefined) {
    body.splice(
      breakAfter + 1,
      0,
      new Paragraph({ children: [new TextRun("After the break.")], pageBreakBefore: true })
    )
  }

  const doc = new Document({ sections: [{ children: body }] })
  return new Uint8Array(await Packer.toBuffer(doc))
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

/** The text drawn into the scanned-page fixture, for OCR assertions. */
export const SCANNED_TEXT = "Patient John Smith"

/**
 * A PDF whose only content is a picture of text — a scan, as far as any text
 * extractor is concerned. Built by drawing to a canvas and embedding the raster,
 * so nothing in the file carries a text object.
 */
export async function makeScannedTextPdfFixture(): Promise<Uint8Array> {
  const { createCanvas } = await import("@napi-rs/canvas")

  const canvas = createCanvas(1224, 400)
  const context = canvas.getContext("2d")
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "#000000"
  context.font = "64px sans-serif"
  context.fillText(SCANNED_TEXT, 60, 200)

  const pdf = await PDFDocument.create()
  const page = pdf.addPage([612, 200])
  const image = await pdf.embedPng(canvas.toBuffer("image/png"))
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 200 })

  return pdf.save()
}
