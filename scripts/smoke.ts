/**
 * End-to-end smoke tests against a running Anonify.
 *
 *   pnpm smoke                          # http://127.0.0.1:3000
 *   pnpm smoke http://localhost:8080
 *   pnpm smoke --only=docx,xlsx         # one or more cases
 *
 * For every supported format: upload, process, accept, export, download — then
 * open the downloaded artifact the way an adversary would and fail if an
 * accepted value survived. It talks to the HTTP API the browser talks to, and
 * asserts on the artifact rather than on the pipeline's own account of itself.
 *
 * This exists because a container can pass every unit test and still not run:
 * file tracing drops a native library, a workflow world resolves to nothing, a
 * bucket was never created. None of that is visible until something asks the
 * assembled system to actually redact a document. CI runs this against
 * `docker compose up`; run it yourself against anything you have deployed.
 *
 * The suite is a list of cases rather than one scripted document, because the
 * interesting failures are per format — a header nobody swept, a shared string
 * table nobody rewrote, an image whose pixels were never touched. A case
 * supplies its bytes and its own `verifyOutput`, which is where the
 * format-specific inspection lives: unzip the package and read every part,
 * sample the pixels, reopen the file.
 *
 * Every document is synthetic and built here — no real personal data, in this
 * repository or in your storage. The fixtures are built in this file rather
 * than imported from `tests/` on purpose: the container image excludes the test
 * tree, and a script the image cannot compile fails the build rather than the
 * smoke test.
 */

import { PDFDocument, StandardFonts, rgb } from "pdf-lib"

const SENSITIVE = {
  person: "John Smith",
  email: "john@example.com",
  phone: "+1 (415) 555-0132",
  account: "4111111111111111",
  author: "Smoke Fixture Author",
} as const

// --- fixtures ---------------------------------------------------------------

async function makePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const page = pdf.addPage([612, 792])

  const lines = [
    `${SENSITIVE.person} works at Example Corporation.`,
    `Email: ${SENSITIVE.email}`,
    `Phone: ${SENSITIVE.phone}`,
  ]

  let y = 720
  for (const text of lines) {
    page.drawText(text, { x: 72, y, size: 12, font, color: rgb(0, 0, 0) })
    y -= 24
  }

  return pdf.save()
}

/**
 * A Word document that keeps the email in three different places: the body, a
 * header and a footer. Redacting `document.xml` alone leaves two of them.
 */
async function makeDocx(): Promise<Uint8Array> {
  const { Document, Footer, Header, Packer, Paragraph, TextRun } = await import(
    "docx"
  )

  const doc = new Document({
    creator: SENSITIVE.author,
    sections: [
      {
        headers: {
          default: new Header({
            children: [new Paragraph(`Prepared for ${SENSITIVE.person}`)],
          }),
        },
        footers: {
          default: new Footer({
            children: [new Paragraph(`Contact ${SENSITIVE.email}`)],
          }),
        },
        children: [
          new Paragraph({
            children: [
              // Split across runs, which is what Word does at every formatting
              // change and what a naive string replacement misses.
              new TextRun({ text: "Email: " }),
              new TextRun({ text: SENSITIVE.email, bold: true }),
            ],
          }),
          new Paragraph(`Phone: ${SENSITIVE.phone}`),
        ],
      },
    ],
  })

  return new Uint8Array(await Packer.toBuffer(doc))
}

/**
 * A workbook with the email in a visible cell, in a formula's cached result,
 * and again on a hidden sheet the user has never opened.
 */
async function makeXlsx(): Promise<Uint8Array> {
  const ExcelJS = (await import("exceljs")).default
  const workbook = new ExcelJS.Workbook()
  workbook.creator = SENSITIVE.author

  const sheet = workbook.addWorksheet("Customers")
  sheet.addRow(["Name", "Email", "Phone"])
  sheet.addRow([SENSITIVE.person, SENSITIVE.email, SENSITIVE.phone])
  sheet.getCell("D2").value = { formula: "B2", result: SENSITIVE.email }

  const archive = workbook.addWorksheet("Archive")
  archive.state = "hidden"
  archive.addRow(["Email"])
  archive.addRow([SENSITIVE.email])

  return new Uint8Array(await workbook.xlsx.writeBuffer())
}


/** A CSV whose values sit in quoted fields, one holding a delimiter. */
function makeCsv(): Uint8Array {
  const text = [
    "name,email,note",
    `${SENSITIVE.person},${SENSITIVE.email},"reached on ${SENSITIVE.phone}, twice"`,
    "Jane Doe,jane@example.com,fine",
    "",
  ].join("\n")
  return new TextEncoder().encode(text)
}

function makeTsv(): Uint8Array {
  const text = [
    "name\temail\tnote",
    `${SENSITIVE.person}\t${SENSITIVE.email}\treached on ${SENSITIVE.phone}`,
    "Jane Doe\tjane@example.com\tfine",
    "",
  ].join("\n")
  return new TextEncoder().encode(text)
}

function makeTxt(): Uint8Array {
  const text = [
    "Client notes",
    "",
    `Name: ${SENSITIVE.person}`,
    `Email: ${SENSITIVE.email}`,
    `Phone: ${SENSITIVE.phone}`,
    "Naive cafe - a line with plain ASCII around it.",
    "",
  ].join("\n")
  return new TextEncoder().encode(text)
}

/**
 * An RTF whose email is split across a formatting group, so the string does
 * not appear in the file at all and only a parse-aware pipeline finds it.
 */
function makeRtf(): Uint8Array {
  const source =
    "{\\rtf1\\ansi{\\fonttbl{\\f0 Times New Roman;}}\\pard " +
    `Client: ${SENSITIVE.person}\\par ` +
    "Email: jo{\\b hn}@example.com\\par " +
    `Phone: ${SENSITIVE.phone}\\par}`
  return new Uint8Array(Buffer.from(source, "latin1"))
}

/**
 * A message with the address in five places: two headers, the plain-text body,
 * the HTML alternative of it, and an attachment's filename.
 */
function makeEml(): Uint8Array {
  const source = [
    `From: ${SENSITIVE.person} <${SENSITIVE.email}>`,
    `Reply-To: ${SENSITIVE.email}`,
    "To: reviewer@example.com",
    "Subject: Quarterly review",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="smoke"',
    "",
    "--smoke",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    `Call ${SENSITIVE.person} on ${SENSITIVE.phone} or write to ${SENSITIVE.email}.`,
    "",
    "--smoke",
    'Content-Type: text/html; charset="utf-8"',
    "",
    `<p>Write to <a href="mailto:${SENSITIVE.email}">jo<span>hn</span>@example.com</a></p>`,
    "",
    "--smoke",
    // Deliberately a format Anonify cannot read, so this case stays about what
    // it has always been about: the filename is redacted, the bytes are
    // carried through, and the multipart structure survives. An attachment in
    // a *supported* format becomes a document of its own and is substituted
    // back redacted — that path has its own suites, in
    // tests/eml-attachments.test.ts and tests/integration.
    "Content-Type: application/octet-stream",
    'Content-Disposition: attachment; filename="review-john@example.com.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from([0x7f, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]).toString(
      "base64"
    ),
    "",
    "--smoke--",
    "",
  ].join("\r\n")
  return new Uint8Array(Buffer.from(source, "latin1"))
}


/**
 * A deck, assembled part by part with fflate.
 *
 * Built here rather than with a library because the shapes that matter are the
 * ones a well-behaved writer never produces: an address split across three
 * runs, and a client name that lives only on the slide master.
 */
async function makePptx(): Promise<Uint8Array> {
  const { zipSync } = await import("fflate")
  const encode = (value: string) => new Uint8Array(Buffer.from(value, "utf8"))
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  const NS =
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
  const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

  const paragraph = (runs: string[]) =>
    `<a:p>${runs
      .map((text) => `<a:r><a:rPr lang="en-US"/><a:t>${text}</a:t></a:r>`)
      .join("")}</a:p>`

  const shape = (paragraphs: string[]) =>
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs.join("")}</p:txBody></p:sp>`

  const tree = (root: string, paragraphs: string[], extra = "") =>
    `${XML}<p:${root} ${NS}${extra}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>' +
    shape(paragraphs) +
    `</p:spTree></p:cSld><p:clrMapOvr/></p:${root}>`

  const rels = (entries: [string, string, string][]) =>
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    entries
      .map(([id, type, target]) =>
        `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`
      )
      .join("") +
    "</Relationships>"

  const ML = "application/vnd.openxmlformats-officedocument.presentationml"

  return zipSync(
    {
      "[Content_Types].xml": encode(
        `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          `<Override PartName="/ppt/presentation.xml" ContentType="${ML}.presentation.main+xml"/>` +
          `<Override PartName="/ppt/slides/slide1.xml" ContentType="${ML}.slide+xml"/>` +
          `<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="${ML}.notesSlide+xml"/>` +
          `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${ML}.slideLayout+xml"/>` +
          `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${ML}.slideMaster+xml"/>` +
          "</Types>"
      ),
      "_rels/.rels": encode(
        rels([["rId1", "officeDocument", "ppt/presentation.xml"]])
      ),
      "ppt/presentation.xml": encode(
        `${XML}<p:presentation ${NS}>` +
          '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
          '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
          '<p:sldSz cx="9144000" cy="5143500"/><p:notesSz cx="6858000" cy="9144000"/>' +
          "</p:presentation>"
      ),
      "ppt/_rels/presentation.xml.rels": encode(
        rels([
          ["rId1", "slideMaster", "slideMasters/slideMaster1.xml"],
          ["rId2", "slide", "slides/slide1.xml"],
        ])
      ),
      "ppt/slides/slide1.xml": encode(
        tree("sld", [
          paragraph([`Account review for ${SENSITIVE.person}`]),
          // Split across three runs: the string is in no part of the XML.
          paragraph(["Contact: ", "jo", "hn@exa", "mple.com"]),
        ])
      ),
      "ppt/slides/_rels/slide1.xml.rels": encode(
        rels([
          ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
          ["rId2", "notesSlide", "../notesSlides/notesSlide1.xml"],
        ])
      ),
      "ppt/notesSlides/notesSlide1.xml": encode(
        tree("notes", [paragraph([`His mobile is ${SENSITIVE.phone}.`])])
      ),
      "ppt/notesSlides/_rels/notesSlide1.xml.rels": encode(
        rels([["rId1", "slide", "../slides/slide1.xml"]])
      ),
      "ppt/slideLayouts/slideLayout1.xml": encode(
        tree("sldLayout", [paragraph(["Prepared by the deck team"])], ' type="obj" preserve="1"')
      ),
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": encode(
        rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])
      ),
      "ppt/slideMasters/slideMaster1.xml": encode(
        tree(
          "sldMaster",
          [paragraph([`${SENSITIVE.person} - confidential`])],
          ' preserve="1"'
        ).replace(
          "<p:clrMapOvr/>",
          '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
        )
      ),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": encode(
        rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"]])
      ),
      "docProps/core.xml": encode(
        `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
          'xmlns:dc="http://purl.org/dc/elements/1.1/">' +
          `<dc:creator>${SENSITIVE.author}</dc:creator></cp:coreProperties>`
      ),
    },
    { level: 6 }
  )
}

/** Where the image fixture's band sits, and the fine detail inside it. */
const BAND = { x: 40, y: 60, width: 160, height: 60 }
const DETAIL = { x: 60, y: 80, width: 12, height: 12 }

/**
 * A JPEG with a coloured band, a white square of fine detail inside it, and
 * EXIF carrying an identifying string. Redaction is then checked by reading the
 * pixels back, not by trusting the pipeline's report.
 */
async function makeImage(): Promise<Uint8Array> {
  const sharp = (await import("sharp")).default

  const output = await sharp({
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
            width: BAND.width,
            height: BAND.height,
            channels: 3,
            background: { r: 20, g: 40, b: 200 },
          },
        },
        left: BAND.x,
        top: BAND.y,
      },
      {
        input: {
          create: {
            width: DETAIL.width,
            height: DETAIL.height,
            channels: 3,
            background: { r: 255, g: 255, b: 255 },
          },
        },
        left: DETAIL.x,
        top: DETAIL.y,
      },
    ])
    .withExif({ IFD0: { Copyright: SENSITIVE.author } })
    .jpeg()
    .toBuffer()

  return new Uint8Array(output)
}

// --- artifact inspection ----------------------------------------------------

type Redaction = {
  id: string
  type: string
  text?: string
  status: string
  page?: number
  worksheet?: string
  row?: number
  column?: number
}

type VerifyContext = {
  /** Every value the run accepted, deduplicated. */
  accepted: string[]
  documentId: string
}

/** Unzips an OOXML package and returns every text-bearing part. */
async function packageParts(
  artifact: Buffer
): Promise<Record<string, string>> {
  const { unzipSync } = await import("fflate")
  const files = unzipSync(new Uint8Array(artifact))

  const parts: Record<string, string> = {}
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.(xml|rels)$/i.test(name)) continue
    parts[name] = Buffer.from(bytes).toString("utf8")
  }
  return parts
}

function assertAbsent(
  haystack: string,
  values: string[],
  where: string
): void {
  const survivors = [...new Set(values)].filter(
    (value) => value.trim().length > 2 && haystack.includes(value)
  )
  if (survivors.length > 0) {
    throw new Error(
      `${survivors.length} value(s) survived in ${where}: ${survivors
        .map((value) => JSON.stringify(value))
        .join(", ")}`
    )
  }
}

/**
 * A PDF's text can be drawn one glyph at a time with positioning operators
 * between the pieces, so a value can be present and invisible to a plain
 * substring search. Stripping the whitespace and the operator punctuation is
 * how that hiding place gets checked too.
 */
function pdfHaystacks(artifact: Buffer): string[] {
  const latin = artifact.toString("latin1")
  return [
    latin,
    artifact.toString("utf8"),
    latin.replace(/[\s()\\<>[\]]/g, ""),
  ]
}

// --- the cases --------------------------------------------------------------

type SmokeCase = {
  name: string
  filename: string
  contentType: string
  bytes: () => Promise<Uint8Array>
  /** How many suggestions the deterministic detectors must produce. */
  expectedRedactions: number
  /**
   * Redactions to create by hand before accepting, for formats where nothing
   * textual is detected. Returns what a reviewer would have drawn.
   */
  manualRedactions?: () => Record<string, unknown>[]
  /** Fixture values that must not survive, checked by name as well as by id. */
  sensitive: string[]
  verifyOutput: (artifact: Buffer, context: VerifyContext) => Promise<void>
}

const CASES: SmokeCase[] = [
  {
    name: "pdf",
    filename: "smoke.pdf",
    contentType: "application/pdf",
    bytes: makePdf,
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email, SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      // It still has to be a PDF afterwards.
      const reopened = await PDFDocument.load(artifact, {
        ignoreEncryption: true,
      })
      if (reopened.getPageCount() !== 1) {
        throw new Error(
          `expected 1 page after export, got ${reopened.getPageCount()}`
        )
      }

      for (const haystack of pdfHaystacks(artifact)) {
        assertAbsent(haystack, context.accepted, "the exported PDF")
      }
      // A redacted page is rebuilt as a raster, so there should be no text
      // operators left carrying the fixture's values in any encoding.
      for (const haystack of pdfHaystacks(artifact)) {
        assertAbsent(
          haystack,
          [SENSITIVE.email, SENSITIVE.phone.replace(/\s/g, "")],
          "the exported PDF"
        )
      }
    },
  },
  {
    name: "docx",
    filename: "smoke.docx",
    contentType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytes: makeDocx,
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email, SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const parts = await packageParts(artifact)

      if (!parts["word/document.xml"]) {
        throw new Error("the exported DOCX has no word/document.xml")
      }

      // Every part, not the rendered document: a value surviving in a header
      // or a footer is still a leak, and those are separate parts.
      for (const [name, xml] of Object.entries(parts)) {
        assertAbsent(xml, context.accepted, `${name} of the exported DOCX`)
        assertAbsent(xml, [SENSITIVE.email], `${name} of the exported DOCX`)
      }

      const headerParts = Object.keys(parts).filter((name) =>
        /^word\/(header|footer)\d*\.xml$/.test(name)
      )
      if (headerParts.length === 0) {
        throw new Error(
          "the exported DOCX lost its headers and footers, so the sweep proved nothing"
        )
      }

      const core = parts["docProps/core.xml"] ?? ""
      if (core.includes(SENSITIVE.author)) {
        throw new Error("document metadata still names the author")
      }
    },
  },
  {
    name: "xlsx",
    filename: "smoke.xlsx",
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    bytes: makeXlsx,
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email, SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const parts = await packageParts(artifact)

      if (!parts["xl/workbook.xml"]) {
        throw new Error("the exported XLSX has no xl/workbook.xml")
      }

      // The shared string table, every worksheet including the hidden one, and
      // any cached formula result: a workbook holds the same value in more
      // places than the cell a reviewer looked at.
      for (const [name, xml] of Object.entries(parts)) {
        assertAbsent(xml, context.accepted, `${name} of the exported XLSX`)
        assertAbsent(xml, [SENSITIVE.email], `${name} of the exported XLSX`)
      }

      const sheets = Object.keys(parts).filter((name) =>
        /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
      )
      if (sheets.length < 2) {
        throw new Error(
          `the exported XLSX has ${sheets.length} worksheet(s); the hidden sheet is missing, so the sweep proved nothing`
        )
      }
    },
  },
  {
    name: "image",
    filename: "smoke.jpg",
    contentType: "image/jpeg",
    bytes: makeImage,
    // Nothing textual to find: the reviewer draws the box, which is the
    // ordinary case for a photograph.
    expectedRedactions: 0,
    manualRedactions: () => [
      {
        type: "region",
        category: "face",
        status: "accepted",
        page: 1,
        boundingBox: BAND,
      },
    ],
    sensitive: [SENSITIVE.author],
    async verifyOutput(artifact) {
      const sharp = (await import("sharp")).default

      const metadata = await sharp(artifact).metadata()
      if (!metadata.width || !metadata.height) {
        throw new Error("the exported image has no readable dimensions")
      }

      /**
       * The mean colour of one region.
       *
       * The crop is materialized before it is measured, because sharp's
       * `stats()` reports on the pipeline's *input* rather than on the
       * operations queued after it: `extract().stats()` silently measures the
       * whole image, and every assertion built on it is really an assertion
       * about the average of the picture.
       */
      const meanOf = async (box: typeof BAND) => {
        const crop = await sharp(artifact)
          .extract({
            left: box.x,
            top: box.y,
            width: box.width,
            height: box.height,
          })
          .png()
          .toBuffer()
        const stats = await sharp(crop).stats()
        return {
          max: Math.max(...stats.channels.map((channel) => channel.max)),
          min: Math.min(...stats.channels.map((channel) => channel.mean)),
          mean: Math.max(...stats.channels.map((channel) => channel.mean)),
        }
      }

      // The band must be filled, and the fine detail inside it must be gone.
      // A rectangle drawn in a viewer would leave both untouched.
      const band = await meanOf(BAND)
      if (band.max > 40) {
        throw new Error(
          `the redacted band still has pixels up to ${band.max}; it was not filled`
        )
      }

      const detail = await meanOf(DETAIL)
      if (detail.mean > 40) {
        throw new Error(
          "the white detail square inside the band survived the redaction"
        )
      }

      // Untouched pixels must still be untouched: a redaction that flattens
      // the whole image is not a redaction, it is a deletion.
      const corner = await meanOf({ x: 300, y: 200, width: 40, height: 40 })
      if (corner.min < 200) {
        throw new Error("the untouched area of the image was altered")
      }

      if (metadata.exif) {
        throw new Error("the exported image still carries EXIF")
      }
      assertAbsent(
        artifact.toString("latin1"),
        [SENSITIVE.author],
        "the exported image's bytes"
      )
    },
  },
  {
    name: "csv",
    filename: "smoke.csv",
    contentType: "text/csv",
    bytes: async () => makeCsv(),
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email, SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const text = artifact.toString("utf8")
      const rows = text.trimEnd().split(/\r?\n/)

      // Still a grid. A naive replacement of a value that sits next to a comma
      // inside a quoted field shifts every field after it, and this is what
      // that failure looks like from the outside.
      if (rows.length !== 3) {
        throw new Error(`expected 3 rows in the exported CSV, got ${rows.length}`)
      }
      for (const row of rows) {
        const fields = splitCsvRow(row)
        if (fields.length !== 3) {
          throw new Error(
            `a row of the exported CSV has ${fields.length} fields, not 3: ${row}`
          )
        }
      }

      assertAbsent(text, context.accepted, "the exported CSV")

      // The header row is content nothing proposed, and it has to survive: a
      // redactor that empties the file passes the assertion above and is
      // useless. (This run accepts every suggestion, so the data rows are
      // expected to be largely gone — the header is what proves the export was
      // selective rather than destructive.)
      if (!text.startsWith("name,email,note")) {
        throw new Error("the CSV export lost its header row")
      }
    },
  },
  {
    name: "tsv",
    filename: "smoke.tsv",
    contentType: "text/tab-separated-values",
    bytes: async () => makeTsv(),
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email],
    async verifyOutput(artifact, context) {
      const text = artifact.toString("utf8")
      const rows = text.trimEnd().split(/\r?\n/)

      if (rows.length !== 3) {
        throw new Error(`expected 3 rows in the exported TSV, got ${rows.length}`)
      }
      for (const row of rows) {
        const fields = row.split("\t")
        if (fields.length !== 3) {
          throw new Error(`a row of the exported TSV has ${fields.length} fields`)
        }
      }

      assertAbsent(text, context.accepted, "the exported TSV")
    },
  },
  {
    name: "txt",
    filename: "smoke.txt",
    contentType: "text/plain",
    bytes: async () => makeTxt(),
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email, SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const text = artifact.toString("utf8")

      assertAbsent(text, context.accepted, "the exported text")
      // Everything outside a redacted range survives exactly.
      for (const kept of ["Client notes", "Naive cafe", "Email: ", "Phone: "]) {
        if (!text.includes(kept)) {
          throw new Error(
            `the text export lost content it was not asked to touch: ${kept}`
          )
        }
      }
    },
  },
  {
    name: "rtf",
    filename: "smoke.rtf",
    contentType: "application/rtf",
    bytes: async () => makeRtf(),
    expectedRedactions: 2,
    sensitive: [SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const source = artifact.toString("latin1")

      // Still RTF: the header, the font table, the closing brace.
      if (!source.startsWith("{\\rtf")) {
        throw new Error("the exported RTF lost its header")
      }
      if (!source.trimEnd().endsWith("}")) {
        throw new Error("the exported RTF is not closed")
      }
      if (!source.includes("fonttbl")) {
        throw new Error("the exported RTF lost its font table")
      }

      assertAbsent(source, context.accepted, "the exported RTF")

      // The address was split across a formatting group in the source, so the
      // string never appeared in the file. Stripping the groups is how you
      // check it is gone from the *text* rather than merely from the bytes —
      // which is the difference between a parse-aware pipeline and a search.
      assertAbsent(
        source.replace(/\{\\[a-z]+ ?|\}/g, ""),
        [SENSITIVE.email],
        "the exported RTF with its formatting groups removed"
      )
    },
  },
  {
    name: "eml",
    filename: "smoke.eml",
    contentType: "message/rfc822",
    bytes: async () => makeEml(),
    expectedRedactions: 2,
    sensitive: [SENSITIVE.email],
    async verifyOutput(artifact, context) {
      const source = artifact.toString("latin1")

      // Reparsed with an independent library: a message only our own parser
      // can read is not a message anybody received.
      const PostalMime = (await import("postal-mime")).default
      const parsed = await PostalMime.parse(artifact).catch((error: unknown) => {
        throw new Error(
          `the exported message could not be reparsed: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      })

      const readable = [
        parsed.subject ?? "",
        parsed.text ?? "",
        parsed.html ?? "",
        ...parsed.headers.map((header) => String(header.value ?? "")),
        ...parsed.attachments.map((attachment) => attachment.filename ?? ""),
      ].join("\n")

      assertAbsent(readable, context.accepted, "the reparsed message")
      assertAbsent(source, context.accepted, "the exported message bytes")

      // The structure survived: the attachment is still there and the
      // boundaries still delimit the parts.
      if (parsed.attachments.length !== 1) {
        throw new Error(
          `expected 1 attachment after export, got ${parsed.attachments.length}`
        )
      }
      if (!source.includes("--smoke")) {
        throw new Error("the exported message lost its multipart boundaries")
      }
    },
  },
  {
    name: "pptx",
    filename: "smoke.pptx",
    contentType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    bytes: makePptx,
    expectedRedactions: 1,
    sensitive: [SENSITIVE.phone],
    async verifyOutput(artifact, context) {
      const parts = await packageParts(artifact)

      if (!parts["ppt/presentation.xml"]) {
        throw new Error("the exported PPTX has no ppt/presentation.xml")
      }

      // Every part: the slide, the notes nobody prints, the layout and the
      // master. Reading only the slides would leave three of the four.
      for (const [name, xml] of Object.entries(parts)) {
        assertAbsent(xml, context.accepted, `${name} of the exported PPTX`)
      }

      for (const required of [
        "ppt/slides/slide1.xml",
        "ppt/notesSlides/notesSlide1.xml",
        "ppt/slideLayouts/slideLayout1.xml",
        "ppt/slideMasters/slideMaster1.xml",
      ]) {
        if (!parts[required]) {
          throw new Error(`the exported PPTX lost ${required}`)
        }
      }

      if ((parts["docProps/core.xml"] ?? "").includes(SENSITIVE.author)) {
        throw new Error("deck metadata still names the author")
      }
    },
  },
]

/** Splits one CSV row, respecting quoted fields. */
function splitCsvRow(row: string): string[] {
  const fields: string[] = []
  let current = ""
  let quoted = false

  for (let index = 0; index < row.length; index++) {
    const character = row[index]
    if (character === '"') {
      if (quoted && row[index + 1] === '"') {
        current += '"'
        index += 1
        continue
      }
      quoted = !quoted
      continue
    }
    if (character === "," && !quoted) {
      fields.push(current)
      current = ""
      continue
    }
    current += character
  }

  fields.push(current)
  return fields
}

// --- HTTP -------------------------------------------------------------------

const argv = process.argv.slice(2)
const only = argv
  .find((argument) => argument.startsWith("--only="))
  ?.slice("--only=".length)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)

const BASE = (
  argv.find((argument) => !argument.startsWith("--")) ??
  process.env.ANONIFY_URL ??
  "http://127.0.0.1:3000"
).replace(/\/$/, "")

/** How long the pipeline gets before we call it hung. */
const READY_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 2_000

/**
 * fetch has no cookie jar, and the session cookie *is* the identity here —
 * every ownership check downstream reads it. Carrying it by hand keeps this
 * dependency-free and makes the identity model visible rather than incidental.
 */
const cookies = new Map<string, string>()

function remember(response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(";")
    const index = pair.indexOf("=")
    if (index > 0) cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1))
  }
}

function cookieHeader(): string {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ")
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (cookies.size > 0) headers.set("cookie", cookieHeader())

  const response = await fetch(`${BASE}${path}`, { ...init, headers })
  remember(response)
  return response
}

async function expectOk(response: Response, what: string): Promise<Response> {
  if (response.ok) return response
  const body = await response.text().catch(() => "")
  throw new Error(
    `${what} failed: ${response.status} ${response.statusText} ${body.slice(0, 300)}`
  )
}

async function json<T>(response: Response, what: string): Promise<T> {
  return (await (await expectOk(response, what)).json()) as T
}

let steps = 0

function step(message: string): void {
  steps += 1
  console.log(`  ${message}`)
}

// --- the run ----------------------------------------------------------------

async function runCase(smokeCase: SmokeCase): Promise<void> {
  console.log(`\n[${smokeCase.name}]`)

  const bytes = await smokeCase.bytes()
  const filename = `smoke-${Date.now()}-${smokeCase.filename}`

  // 1. Reserve. Writes a row, charges the upload quota, and tells the client
  //    which upload path this install is configured for.
  const reserved = await json<{
    id: string
    pathname: string
    uploadMode: string
  }>(
    await call("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        filename,
        size: bytes.byteLength,
        contentType: smokeCase.contentType,
        ttlSeconds: 3600,
      }),
    }),
    "reserve"
  )
  step(`reserved ${reserved.id} (upload mode: ${reserved.uploadMode})`)

  // 2. Upload. On a self-hosted install this goes through the app to an
  //    S3-compatible service or the local filesystem; on Vercel the browser
  //    uploads to Blob directly and this script would have nothing to do here.
  if (reserved.uploadMode === "vercel-blob") {
    throw new Error(
      "This install is configured for direct Vercel Blob uploads, which the " +
        "browser performs with a scoped token. Point the smoke test at a " +
        "self-hosted instance instead."
    )
  }

  const form = new FormData()
  form.set("documentId", reserved.id)
  form.set(
    "file",
    new File([new Uint8Array(bytes)], filename, { type: smokeCase.contentType })
  )

  const uploaded = await json<{ url: string; size: number }>(
    await call("/api/upload/local", { method: "POST", body: form }),
    "upload"
  )
  step(`uploaded ${uploaded.size} bytes`)

  // 3. Hand it to the durable pipeline: ingest, extraction, normalization,
  //    detection all run in the workflow from here.
  await json<{ runId: string }>(
    await call(`/api/documents/${reserved.id}/process`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blobUrl: uploaded.url }),
    }),
    "process"
  )

  const deadline = Date.now() + READY_TIMEOUT_MS
  let summary: {
    status: string
    kind: string
    pageCount: number | null
    error?: string | null
  }

  for (;;) {
    summary = await json(
      await call(`/api/documents/${reserved.id}`),
      "document status"
    )
    if (summary.status === "ready") break
    if (summary.status === "failed") {
      throw new Error(`processing failed: ${summary.error ?? "no reason given"}`)
    }
    if (Date.now() > deadline) {
      throw new Error(
        `still ${summary.status} after ${READY_TIMEOUT_MS / 1000}s — ` +
          "the workflow worker is probably not running"
      )
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  step(`ready as ${summary.kind}, ${summary.pageCount ?? 0} page(s)`)

  // 4. Suggestions. Without an AI key only the deterministic detectors run,
  //    which is exactly the configuration CI uses — the fixtures' emails and
  //    phone numbers are found by pattern alone, so these assertions hold with
  //    or without a model.
  const { redactions } = await json<{ redactions: Redaction[] }>(
    await call(`/api/documents/${reserved.id}/redactions`),
    "list redactions"
  )

  if (redactions.length < smokeCase.expectedRedactions) {
    throw new Error(
      `expected at least ${smokeCase.expectedRedactions} suggestion(s), got ${redactions.length}`
    )
  }
  step(`${redactions.length} suggestion(s)`)

  // 5. A reviewer's own redactions, for formats where detection finds nothing
  //    textual to propose.
  const created: Redaction[] = []
  for (const manual of smokeCase.manualRedactions?.() ?? []) {
    const { redaction } = await json<{ redaction: Redaction }>(
      await call(`/api/documents/${reserved.id}/redactions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manual),
      }),
      "create redaction"
    )
    created.push(redaction)
  }
  if (created.length > 0) step(`drew ${created.length} region(s) by hand`)

  // 6. Accept. This is the only step that makes any of it count.
  const ids = redactions.map((redaction) => redaction.id)
  if (ids.length > 0) {
    await json<{ updated: number }>(
      await call(`/api/documents/${reserved.id}/redactions`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids, status: "accepted" }),
      }),
      "accept"
    )
  }
  step(`accepted ${ids.length + created.length}`)

  const exported = await json<{
    size: number
    appliedRedactions: number
    verifiedValues: number
    downloadUrl: string
    reportUrl: string
  }>(
    await call(`/api/documents/${reserved.id}/export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addLabels: false, sanitizeMetadata: true }),
    }),
    "export"
  )
  step(
    `exported ${exported.size} bytes, ${exported.appliedRedactions} applied, ` +
      `${exported.verifiedValues} verified`
  )

  // 7. Read the artifact back and look for the values ourselves. The export
  //    already refuses to deliver a file that fails its own verification; this
  //    is the independent check, which is the only kind worth having.
  const download = await expectOk(await call(exported.downloadUrl), "download")
  const artifact = Buffer.from(await download.arrayBuffer())

  const accepted = [
    ...new Set(
      [...redactions, ...created]
        .map((redaction) => redaction.text)
        .filter((text): text is string => Boolean(text && text.trim().length > 2))
    ),
  ]

  await smokeCase.verifyOutput(artifact, {
    accepted,
    documentId: reserved.id,
  })

  // The fixture's values by name too, so a change to what the detectors return
  // cannot quietly turn the assertion above into a no-op.
  assertAbsent(
    `${artifact.toString("latin1")}\n${artifact.toString("utf8")}`,
    smokeCase.sensitive,
    "the exported artifact"
  )
  step(`downloaded ${artifact.byteLength} bytes, artifact verified`)

  // 8. The export report, checked the same adversarial way. It is delivered to
  //    people who were never shown the original, so "counts, not content" has
  //    to be true of the bytes rather than of the intention.
  const reportText = await (
    await expectOk(await call(exported.reportUrl), "report")
  ).text()
  const report = JSON.parse(reportText) as {
    removed: { total: number }
    artifact: { checksum: string }
  }

  if (report.removed.total !== exported.appliedRedactions) {
    throw new Error(
      `report says ${report.removed.total} removed, export applied ${exported.appliedRedactions}`
    )
  }
  assertAbsent(reportText, accepted, "the export report")
  step(`report accounts for ${report.removed.total} removals and quotes none`)

  // 9. Clean up after ourselves, and exercise deletion while we are here.
  await expectOk(
    await call(`/api/documents/${reserved.id}`, { method: "DELETE" }),
    "delete"
  )
  step("deleted")
}

async function main(): Promise<void> {
  const selected = only
    ? CASES.filter((smokeCase) => only.includes(smokeCase.name))
    : CASES

  if (selected.length === 0) {
    throw new Error(
      `no cases matched --only; available: ${CASES.map((c) => c.name).join(", ")}`
    )
  }

  console.log(`smoke: ${BASE}`)
  console.log(`cases: ${selected.map((smokeCase) => smokeCase.name).join(", ")}`)

  // 0. The app is serving. A standalone build with a missing static chunk or a
  //    world that failed to load falls over right here.
  await expectOk(await call("/"), "GET /")

  for (const smokeCase of selected) {
    await runCase(smokeCase)
  }

  console.log(
    `\nsmoke passed — ${selected.length} format(s), ${steps} steps`
  )
}

main().catch((error: unknown) => {
  console.error(`\nsmoke FAILED after ${steps} step(s)`)
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
