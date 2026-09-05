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

      // pnpm keeps the real package behind a symlink into the store, and the
      // standalone copy does not always follow that symlink for a `**` glob, so
      // the store path is listed alongside the hoisted one. The pdfjs font/CMap
      // warnings ("Unable to load font data") traced to the standalone copy
      // shipping the symlink and not the files it points at.
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/cmaps/**",
      "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",

      // tesseract.js runs its recognizer in a Node Worker whose entry file is a
      // runtime-computed path (path.join(__dirname, '..', '..', 'worker-script',
      // 'node', 'index.js')) handed to `new Worker(workerPath)`. File tracing
      // follows static require/import edges but cannot follow that, so the whole
      // src/worker-script/** tree — and the packages only it requires — is dropped
      // from the standalone build. The worker then does `require('..')` from
      // src/worker-script/node/index.js, its target is absent, and the process
      // dies with `uncaughtException: Cannot find module '..'`. Both layouts are
      // listed because pnpm places the package in the store and hoists a symlink.
      "./node_modules/tesseract.js/**",
      "./node_modules/.pnpm/tesseract.js@*/node_modules/tesseract.js/**",
      "./node_modules/tesseract.js-core/**",
      "./node_modules/.pnpm/tesseract.js-core@*/node_modules/tesseract.js-core/**",

      // Required only from the worker script, so tracing from the package entry
      // never reaches them. Small enough to ship wholesale.
      "./node_modules/is-url/**",
      "./node_modules/.pnpm/is-url@*/node_modules/is-url/**",
      "./node_modules/bmp-js/**",
      "./node_modules/.pnpm/bmp-js@*/node_modules/bmp-js/**",
      "./node_modules/wasm-feature-detect/**",
      "./node_modules/.pnpm/wasm-feature-detect@*/node_modules/wasm-feature-detect/**",
      "./node_modules/node-fetch/**",
      "./node_modules/.pnpm/node-fetch@*/node_modules/node-fetch/**",
      "./node_modules/regenerator-runtime/**",
      "./node_modules/.pnpm/regenerator-runtime@*/node_modules/regenerator-runtime/**",
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
