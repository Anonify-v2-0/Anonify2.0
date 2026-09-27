/**
 * The parts of exceljs's own loader that lib/documents/xlsx/stream.ts drives
 * one sheet at a time. They are plain CommonJS with no published types; these
 * say only as much as that file uses.
 */

declare module "exceljs/lib/xlsx/xform/*" {
  const Xform: new (options?: unknown) => {
    parseStream(stream: AsyncIterable<string>): Promise<unknown>
    reconcile(model: unknown, options?: unknown): void
  }
  export = Xform
}

declare module "exceljs/lib/doc/worksheet" {
  import type ExcelJS from "exceljs"
  const Worksheet: new (options: {
    id: unknown
    name: unknown
    orderNo: unknown
    state: unknown
    workbook: ExcelJS.Workbook
  }) => ExcelJS.Worksheet & { model: unknown }
  export = Worksheet
}
