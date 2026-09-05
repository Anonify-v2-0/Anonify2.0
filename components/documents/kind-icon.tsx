import {
  FileSpreadsheet,
  FileText,
  FileType,
  Image as ImageIcon,
  Mail,
  Presentation,
  type LucideIcon,
} from "lucide-react"

import type { DocumentKind } from "@/types/document"

/**
 * The icon each supported format is shown with.
 *
 * One map, because a kind that reads as a spreadsheet in the document list and
 * as something else on the landing page is a kind the reader has to learn
 * twice. Typed as `Record<DocumentKind, LucideIcon>`, so a kind added to
 * `DOCUMENT_KINDS` without an icon does not compile — the same rule the format
 * register in `lib/documents/formats.ts` enforces for everything else.
 *
 * It lives here rather than in that register because the register is imported
 * by server-side extraction and export code that has no business pulling a
 * React icon library in with it.
 */
export const KIND_ICONS: Record<DocumentKind, LucideIcon> = {
  pdf: FileText,
  docx: FileText,
  xlsx: FileSpreadsheet,
  image: ImageIcon,
  // A delimited file is a grid, and reads as one in the workspace.
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  txt: FileType,
  rtf: FileType,
  eml: Mail,
  pptx: Presentation,
}
