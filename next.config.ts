import type { NextConfig } from "next"
import { withWorkflow } from "workflow/next"

const nextConfig: NextConfig = {
  // Emits a self-contained server with only the traced dependencies, so the
  // container does not ship a 2 GB node_modules.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,

  // Server-side PDF extraction reads font and CMap data from disk, so those
  // assets have to travel with the serverless bundle.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/cmaps/**",
      // File tracing follows sharp's .node binding but not the libvips shared
      // object that binding dlopens at load time, so a standalone build ships a
      // binding that cannot link. Two globs because a hoisted node_modules and
      // pnpm's store place the package differently.
      "./node_modules/@img/sharp-libvips-*/lib/*",
      "./node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*",
    ],
  },
  // Native and worker-bearing packages must stay outside the bundler.
  serverExternalPackages: [
    "pdfjs-dist",
    "sharp",
    "tesseract.js",
    "@napi-rs/canvas",
    // Loaded by the workflow runtime through a runtime require; bundling it
    // would break that resolution and lose the pg driver.
    "@workflow/world-postgres",
  ],
}

export default withWorkflow(nextConfig)
