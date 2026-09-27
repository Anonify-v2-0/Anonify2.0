import ExcelJS from "exceljs"
import Worksheet from "exceljs/lib/doc/worksheet"
import WorkbookXform from "exceljs/lib/xlsx/xform/book/workbook-xform"
import CommentsXform from "exceljs/lib/xlsx/xform/comment/comments-xform"
import VmlNotesXform from "exceljs/lib/xlsx/xform/comment/vml-notes-xform"
import AppXform from "exceljs/lib/xlsx/xform/core/app-xform"
import CoreXform from "exceljs/lib/xlsx/xform/core/core-xform"
import RelationshipsXform from "exceljs/lib/xlsx/xform/core/relationships-xform"
import DrawingXform from "exceljs/lib/xlsx/xform/drawing/drawing-xform"
import WorksheetXform from "exceljs/lib/xlsx/xform/sheet/worksheet-xform"
import SharedStringsXform from "exceljs/lib/xlsx/xform/strings/shared-strings-xform"
import StylesXform from "exceljs/lib/xlsx/xform/style/styles-xform"
import TableXform from "exceljs/lib/xlsx/xform/table/table-xform"

import {
  NormalizedJsonWriter,
  type NormalizedIndex,
} from "@/lib/documents/normalized-json"
import { ZipFallback, type ZipArchive, type ZipEntry } from "@/lib/documents/ooxml/zip"
import { NO_READABLE_SHEETS, readSheet } from "@/lib/documents/xlsx/extract"

/**
 * XLSX extraction that holds one worksheet at a time.
 *
 * The whole-file path hands exceljs the workbook, and exceljs inflates every
 * part, parses every sheet into its object model, and only then lets anyone
 * read a cell. For a workbook of any size that object model is the memory:
 * several hundred bytes per cell, for every cell of every sheet at once.
 *
 * This runs the same exceljs code — the same xforms, the same reconcile, the
 * same `Worksheet` — over the same parts in the same order, with one
 * difference: a worksheet is parsed when it is about to be written and let go
 * once it has been. Everything a sheet is reconciled against (shared strings,
 * styles, relationships, drawings, tables, comments) is small and read first,
 * exactly as the whole-file loader reads it. The parts are inflated a window
 * at a time from ranged reads of the sealed source (lib/documents/ooxml/zip.ts),
 * so the workbook itself is never whole in memory either.
 *
 * What it writes is what `JSON.stringify(extractXlsx(...).document)` would
 * have been. Where it cannot be sure of that — an archive two zip parsers
 * could read differently, bytes that are not UTF-8 — it throws `ZipFallback`
 * and the caller extracts the workbook whole. tests/xlsx-stream.test.ts holds
 * the two paths to one answer.
 */

/** A worksheet part, before anything has been read out of it. */
type SheetStub = {
  path: string
  sheetNo: string
  entry: ZipEntry
  // Set by exceljs's workbook reconcile, from xl/workbook.xml.
  name?: unknown
  id?: unknown
  state?: unknown
}

type LoaderModel = {
  worksheets: SheetStub[]
  worksheetHash: Record<string, SheetStub>
  worksheetRels: Record<string, unknown>
  themes: Record<string, unknown>
  media: { type: string; name: string; extension: string; buffer: Buffer }[]
  mediaIndex: Record<string, number>
  drawings: Record<string, { anchors?: unknown[] }>
  drawingRels: Record<string, { Id: string; Target: string }[]>
  comments: Record<string, unknown>
  tables: Record<string, unknown>
  vmlDrawings: Record<string, unknown>
  sheets?: { id: unknown }[]
  definedNames?: unknown
  properties?: { date1904?: boolean }
  sharedStrings?: unknown
  styles?: unknown
  workbookRels?: unknown
  globalRels?: unknown
  title?: string
  [key: string]: unknown
}

/**
 * An entry's text, a piece at a time, decoded as the whole-file loader
 * decodes it.
 *
 * JSZip hands exceljs `Buffer.toString("utf-8")` of the whole entry: a
 * byte-order mark kept, invalid sequences replaced. Streaming the decode
 * keeps the first and is chunk-proof; the second is where two decoders can
 * disagree, so invalid bytes are refused here and the workbook is read whole.
 */
async function* textOf(archive: ZipArchive, entry: ZipEntry): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
  try {
    for await (const piece of archive.read(entry)) {
      const text = decoder.decode(piece, { stream: true })
      if (text) yield text
    }
    const rest = decoder.decode()
    if (rest) yield rest
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ZipFallback("a part that is not UTF-8")
    }
    throw error
  }
}

/** Reads an entry to the end without keeping it, so it fails where JSZip would. */
async function drain(archive: ZipArchive, entry: ZipEntry): Promise<void> {
  for await (const piece of archive.read(entry)) void piece
}

async function parse(xform: { parseStream(stream: AsyncIterable<string>): Promise<unknown> }, archive: ZipArchive, entry: ZipEntry) {
  return xform.parseStream(textOf(archive, entry))
}

export class XlsxExtractionStream {
  private readonly out = new NormalizedJsonWriter()
  private cells = 0

  constructor(
    private readonly documentId: string,
    private readonly archive: ZipArchive
  ) {}

  /** Cells written — the quantity a workbook is charged by. */
  get cellCount(): number {
    return this.cells
  }

  /** Where the (empty) pages array landed; complete once `json` has finished. */
  get index(): NormalizedIndex {
    return this.out.index
  }

  /** The model as JSON, a sheet at a time. */
  async *json(): AsyncGenerator<string> {
    const model = await this.loadParts()
    const workbook = new ExcelJS.Workbook()
    const { emitted, rest } = this.arrange(model, workbook)

    if (emitted.length === 0) throw new Error(NO_READABLE_SHEETS)

    this.out.push(
      `{"documentId":${JSON.stringify(this.documentId)},"kind":"xlsx",`
    )
    this.out.beginPages()
    this.out.endPages()
    this.out.push(`,"sheets":[`)
    yield this.out.take()

    const sheetOptions = {
      styles: model.styles,
      sharedStrings: model.sharedStrings,
      media: model.media,
      mediaIndex: model.mediaIndex,
      date1904: model.properties && model.properties.date1904,
      drawings: model.drawings,
      comments: model.comments,
      tables: model.tables,
      vmlDrawings: model.vmlDrawings,
    }
    const worksheetXform = new WorksheetXform()

    for (const [position, { stub, worksheet }] of emitted.entries()) {
      await this.load(stub, worksheet, worksheetXform, sheetOptions, model)
      const sheet = readSheet(worksheet)
      this.cells += sheet.cells.length
      this.out.push(`${position === 0 ? "" : ","}${JSON.stringify(sheet)}`)
      release(worksheet)
      yield this.out.take()
    }

    // Parsed and dropped: the whole-file loader parses and reconciles every
    // worksheet part, including ones the workbook does not list, and a part
    // that fails there fails the workbook. It fails it here too.
    for (const { stub, worksheet } of rest) {
      await this.load(stub, worksheet, worksheetXform, sheetOptions, model)
      if (worksheet) release(worksheet)
    }

    this.out.push(
      `],"metadata":${JSON.stringify({
        sheetCount: emitted.length,
        workbookName: model.title ?? undefined,
      })}}`
    )
    yield this.out.take()
  }

  /**
   * Every part except the worksheets, read the way exceljs's `load` reads
   * them, in the same order and through the same xforms. Worksheets are only
   * noted, to be read one at a time later.
   */
  private async loadParts(): Promise<LoaderModel> {
    const model: LoaderModel = {
      worksheets: [],
      worksheetHash: {},
      worksheetRels: [] as unknown as Record<string, unknown>,
      themes: {},
      media: [],
      mediaIndex: {},
      drawings: {},
      drawingRels: {},
      comments: {},
      tables: {},
      vmlDrawings: {},
    }
    const archive = this.archive

    for (const entry of archive.entries) {
      if (entry.directory) continue
      let name = entry.name
      if (name[0] === "/") name = name.substring(1)

      switch (name) {
        case "_rels/.rels":
          model.globalRels = await parse(new RelationshipsXform(), archive, entry)
          continue
        case "xl/workbook.xml": {
          const workbook = (await parse(new WorkbookXform(), archive, entry)) as LoaderModel
          model.sheets = workbook.sheets
          model.definedNames = workbook.definedNames
          model.views = workbook.views
          model.properties = workbook.properties
          model.calcProperties = workbook.calcProperties
          continue
        }
        case "xl/_rels/workbook.xml.rels":
          model.workbookRels = await parse(new RelationshipsXform(), archive, entry)
          continue
        case "xl/sharedStrings.xml": {
          const xform = new SharedStringsXform()
          await parse(xform, archive, entry)
          model.sharedStrings = xform
          continue
        }
        case "xl/styles.xml": {
          const xform = new StylesXform()
          await parse(xform, archive, entry)
          model.styles = xform
          continue
        }
        case "docProps/app.xml": {
          const app = (await parse(new AppXform(), archive, entry)) as LoaderModel
          model.company = app.company
          model.manager = app.manager
          continue
        }
        case "docProps/core.xml":
          Object.assign(model, await parse(new CoreXform(), archive, entry))
          continue
      }

      let match = name.match(/xl\/worksheets\/sheet(\d+)[.]xml/)
      if (match) {
        const stub: SheetStub = { path: name, sheetNo: match[1], entry }
        model.worksheetHash[name] = stub
        model.worksheets.push(stub)
        continue
      }
      match = name.match(/xl\/worksheets\/_rels\/sheet(\d+)[.]xml.rels/)
      if (match) {
        model.worksheetRels[match[1]] = await parse(new RelationshipsXform(), archive, entry)
        continue
      }
      match = name.match(/xl\/theme\/([a-zA-Z0-9]+)[.]xml/)
      if (match) {
        // Kept by exceljs as a string nobody here reads.
        await drain(archive, entry)
        continue
      }
      match = name.match(/xl\/media\/([a-zA-Z0-9]+[.][a-zA-Z0-9]{3,4})$/)
      if (match) {
        // The picture itself is never needed to read cells; its name and
        // position in the list are, because drawings refer to it by them.
        await drain(archive, entry)
        const filename = match[1]
        const lastDot = filename.lastIndexOf(".")
        if (lastDot >= 1) {
          model.mediaIndex[filename] = model.media.length
          model.mediaIndex[filename.substring(0, lastDot)] = model.media.length
          model.media.push({
            type: "image",
            name: filename.substring(0, lastDot),
            extension: filename.substring(lastDot + 1),
            buffer: Buffer.alloc(0),
          })
        }
        continue
      }
      match = name.match(/xl\/drawings\/([a-zA-Z0-9]+)[.]xml/)
      if (match) {
        model.drawings[match[1]] = (await parse(new DrawingXform(), archive, entry)) as {
          anchors?: unknown[]
        }
        continue
      }
      match = name.match(/xl\/(comments\d+)[.]xml/)
      if (match) {
        model.comments[`../${match[1]}.xml`] = await parse(new CommentsXform(), archive, entry)
        continue
      }
      match = name.match(/xl\/tables\/(table\d+)[.]xml/)
      if (match) {
        model.tables[`../tables/${match[1]}.xml`] = await parse(new TableXform(), archive, entry)
        continue
      }
      match = name.match(/xl\/drawings\/_rels\/([a-zA-Z0-9]+)[.]xml[.]rels/)
      if (match) {
        model.drawingRels[match[1]] = (await parse(
          new RelationshipsXform(),
          archive,
          entry
        )) as { Id: string; Target: string }[]
        continue
      }
      match = name.match(/xl\/drawings\/(vmlDrawing\d+)[.]vml/)
      if (match) {
        model.vmlDrawings[`../drawings/${match[1]}.vml`] = await parse(
          new VmlNotesXform(),
          archive,
          entry
        )
        continue
      }
      // Anything else exceljs reads as a string and ignores.
      await drain(archive, entry)
    }

    this.reconcileWorkbook(model)
    return model
  }

  /** exceljs's `reconcile`, up to the point where it would touch a worksheet. */
  private reconcileWorkbook(model: LoaderModel): void {
    new WorkbookXform().reconcile(model)

    const drawingXform = new DrawingXform()
    const drawingOptions: Record<string, unknown> = {
      media: model.media,
      mediaIndex: model.mediaIndex,
    }
    for (const name of Object.keys(model.drawings)) {
      const drawing = model.drawings[name]
      const drawingRel = model.drawingRels[name]
      if (!drawingRel) continue
      const rels = drawingRel.reduce<Record<string, { Target: string }>>((map, rel) => {
        map[rel.Id] = rel
        return map
      }, {})
      drawingOptions.rels = rels
      for (const anchor of (drawing.anchors ?? []) as {
        picture?: { hyperlinks?: { rId?: string; hyperlink?: string } }
      }[]) {
        const hyperlinks = anchor.picture && anchor.picture.hyperlinks
        if (hyperlinks && hyperlinks.rId && rels[hyperlinks.rId]) {
          hyperlinks.hyperlink = rels[hyperlinks.rId].Target
          delete hyperlinks.rId
        }
      }
      drawingXform.reconcile(drawing, drawingOptions)
    }

    const tableXform = new TableXform()
    for (const table of Object.values(model.tables)) {
      tableXform.reconcile(table, { styles: model.styles })
    }
  }

  /**
   * The workbook's worksheets, created as `Workbook.model` creates them —
   * which is where a duplicated or illegal sheet name is refused — and put in
   * the order `eachSheet` visits them. The ones it never visits are kept aside
   * to be parsed for their failures only.
   */
  private arrange(model: LoaderModel, workbook: ExcelJS.Workbook) {
    const byId = (workbook as unknown as { _worksheets: unknown[] })._worksheets
    const created: { stub: SheetStub; worksheet: ExcelJS.Worksheet & { model: unknown } }[] = []

    for (const stub of model.worksheets) {
      const orderNo = model.sheets && model.sheets.findIndex((sheet) => sheet.id === stub.id)
      const worksheet = new Worksheet({
        id: stub.id,
        name: stub.name,
        orderNo,
        state: stub.state,
        workbook,
      })
      ;(byId as unknown as Record<string, unknown>)[String(stub.id)] = worksheet
      created.push({ stub, worksheet })
    }

    const visited = new Set<unknown>(workbook.worksheets)
    const emitted = workbook.worksheets.map((worksheet) => {
      const found = created.find((candidate) => candidate.worksheet === worksheet)
      if (!found) throw new Error("A worksheet the workbook lists was never created")
      return found
    })
    const rest = created.filter(({ worksheet }) => !visited.has(worksheet))
    return { emitted, rest }
  }

  private async load(
    stub: SheetStub,
    worksheet: ExcelJS.Worksheet & { model: unknown },
    worksheetXform: InstanceType<typeof WorksheetXform>,
    sheetOptions: Record<string, unknown>,
    model: LoaderModel
  ): Promise<void> {
    const sheetModel = (await parse(new WorksheetXform(), this.archive, stub.entry)) as Record<
      string,
      unknown
    >
    sheetModel.sheetNo = stub.sheetNo
    // What the workbook reconcile wrote onto the stub belongs on the model the
    // whole-file loader would have written it onto.
    for (const [key, value] of Object.entries(stub)) {
      if (key === "path" || key === "entry" || key === "sheetNo") continue
      // A print area is added to the page setup the sheet already declared,
      // not written over it.
      if (key === "pageSetup" && sheetModel.pageSetup) {
        Object.assign(sheetModel.pageSetup as object, value)
        continue
      }
      sheetModel[key] = value
    }
    sheetModel.relationships = model.worksheetRels[stub.sheetNo]
    worksheetXform.reconcile(sheetModel, sheetOptions)
    ;(worksheet as { model: unknown }).model = sheetModel
  }
}

/** Lets a worksheet's cells go once they have been written. */
function release(worksheet: ExcelJS.Worksheet): void {
  const internal = worksheet as unknown as Record<string, unknown>
  internal._rows = []
  internal._columns = null
  internal._merges = {}
  internal._media = []
}
