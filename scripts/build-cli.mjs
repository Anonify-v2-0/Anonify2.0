/**
 * Compiles the command-line jobs the container image runs without a server.
 *
 *   node scripts/build-cli.mjs   ->  build/cli/cleanup.mjs
 *
 * The image's standalone server has no `tsx` and no TypeScript sources, so
 * `anonify cleanup` cannot run scripts/cleanup.ts the way `pnpm cleanup` does.
 * Bundled, the sweep is one file that needs nothing beside it: a scheduler
 * that runs a job rather than calling a URL can run it with no web replica up
 * (#175).
 */
import { build } from "esbuild"

await build({
  entryPoints: { cleanup: "scripts/cleanup.ts" },
  outdir: "build/cli",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Dependencies written as CommonJS call `require`, which an ES module does
  // not have.
  banner: {
    js: "import { createRequire as __anonifyRequire } from 'node:module'; const require = __anonifyRequire(import.meta.url);",
  },
  logLevel: "warning",
})
