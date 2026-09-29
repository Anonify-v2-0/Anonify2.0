// Copies the pdf.js worker next to the static assets so the browser viewer can
// load it from a stable URL under any bundler.
//
// The legacy build, to match the library hooks/use-pdf-document.ts loads: the
// default worker calls methods (Map.prototype.getOrInsertComputed) that many
// browsers, most phones among them, do not have yet.
import { createRequire } from "node:module"
import { copyFile, mkdir } from "node:fs/promises"
import path from "node:path"

const require = createRequire(import.meta.url)
const root = path.dirname(require.resolve("pdfjs-dist/package.json"))
const source = path.join(root, "legacy", "build", "pdf.worker.min.mjs")
const target = path.join(process.cwd(), "public", "pdf.worker.min.mjs")

await mkdir(path.dirname(target), { recursive: true })
await copyFile(source, target)
console.log(`pdf.js worker copied to ${path.relative(process.cwd(), target)}`)
