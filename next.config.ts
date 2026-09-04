import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // Server-side PDF extraction reads font and CMap data from disk, so those
  // assets have to travel with the serverless bundle.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/standard_fonts/**",
      "./node_modules/pdfjs-dist/cmaps/**",
    ],
  },
  serverExternalPackages: ["pdfjs-dist"],
}

export default nextConfig
