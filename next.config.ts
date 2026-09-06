import type { NextConfig } from "next"
import { withWorkflow } from "workflow/next"

/**
 * Assets the PDF and image pipelines read from disk at runtime.
 *
 * File tracing follows static import edges. These are opened by path at run
 * time instead, so nothing points at them and a per-function bundle drops them
 * unless they are named here. Both a hoisted `node_modules/<pkg>` and pnpm's
 * store path are listed because the two layouts place a package differently and
 * the standalone copy does not always follow the symlink for a `**` glob — the
 * pdfjs "Unable to load font data" warnings traced to exactly that.
 */
const RENDERING_ASSETS = [
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "./node_modules/pdfjs-dist/standard_fonts/**",
  "./node_modules/pdfjs-dist/cmaps/**",
  "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/standard_fonts/**",
  "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/cmaps/**",
  "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",

  // File tracing follows sharp's .node binding but not the libvips shared
  // object that binding dlopens at load time, so a bundle ships a binding that
  // cannot link.
  "./node_modules/@img/sharp-libvips-*/lib/*",
  "./node_modules/.pnpm/@img+sharp-libvips-*/node_modules/@img/*/lib/*",
]

/**
 * The Tesseract worker tree, and the packages only it requires.
 *
 * tesseract.js runs its recognizer in a Node Worker whose entry file is a
 * runtime-computed path (path.join(__dirname, '..', '..', 'worker-script',
 * 'node', 'index.js')) handed to `new Worker(workerPath)`. Tracing cannot
 * follow that, so the whole src/worker-script/** tree — and the WASM core it
 * loads through its own resolver — is dropped. The worker then does
 * `require('..')` from src/worker-script/node/index.js, its target is absent,
 * and the process dies with `uncaughtException: Cannot find module '..'`.
 *
 * Kept separate from RENDERING_ASSETS because it is by far the largest thing
 * this app can ship — tesseract.js-core alone is ~45 MB per copy, and both
 * layouts are listed — and only one entry point ever runs OCR. Adding it to
 * every route put ~90 MB into functions that serve JSON, which is how a
 * deployment gets close to Vercel's 250 MB uncompressed function ceiling for
 * no reason. See `outputFileTracingIncludes` below for where it does go.
 */
const OCR_ASSETS = [
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
]

/**
 * Whether this build will ever run Tesseract.
 *
 * OCR provider selection is `OCR_PROVIDER`, read in lib/ocr/index.ts, and
 * `tesseract.js` is reached only through a dynamic import inside that
 * provider's own `start()`. A build that names a hosted provider therefore
 * never loads the package at all, and the ~145 MB the globs above add to the
 * bundle is dead weight — on Vercel, dead weight measured against a 250 MB
 * uncompressed ceiling that the step function otherwise comes within 20 MB of.
 *
 * Skipping is safe because selection refuses rather than falls back: an
 * `OCR_PROVIDER` that cannot run raises, so there is no path where a build made
 * without these assets quietly tries to use them. The default keeps them,
 * because the default is a clone that should read a scan without an account.
 */
const bundlesTesseract =
  (process.env.OCR_PROVIDER?.trim().toLowerCase() || "tesseract") === "tesseract"

const nextConfig: NextConfig = {
  // Emits a self-contained server with only the traced dependencies, so the
  // container does not ship a 2 GB node_modules.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,

  /**
   * Which bundle gets which assets.
   *
   * On a container this distinction does not exist: `output: "standalone"`
   * merges every route's trace into one server directory, so anything listed
   * anywhere is present everywhere. On Vercel each route is its own function
   * with its own bundle, and the keys below decide what each one contains.
   *
   * `/.well-known/workflow/**` is not decoration. The Workflow SDK generates
   * its step handler at `app/.well-known/workflow/v1/step/route.js`, and *that*
   * is where extraction, rasterisation and OCR actually execute on Vercel — the
   * `/api/**` routes only start runs and read their results. A key covering
   * only `/api/**` therefore puts the assets everywhere except the one function
   * that opens them, and the failure arrives as a workflow step exhausting its
   * retries against a missing font or a worker that cannot find its core.
   *
   * OCR is scoped to the step route alone because nothing under `/api/**` ever
   * calls it, and it is large enough that shipping it to routes that do not use
   * it costs a function's whole size budget.
   */
  outputFileTracingIncludes: {
    "/api/**": RENDERING_ASSETS,
    "/.well-known/workflow/**": bundlesTesseract
      ? [...RENDERING_ASSETS, ...OCR_ASSETS]
      : RENDERING_ASSETS,
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
