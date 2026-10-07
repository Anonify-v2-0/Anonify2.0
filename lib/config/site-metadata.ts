import type { Metadata } from "next"

import { publicUrl } from "@/lib/config/public-url"

/**
 * The site's metadata, apart from the one field that depends on where it is
 * served from. Everything here is the same for every instance.
 */
const STATIC_METADATA: Metadata = {
  title: "Anonify — AI-assisted document redaction",
  description:
    "Redact sensitive information from PDF, Word, Excel, PowerPoint, email, CSV, text and image files without destroying the document. AI proposes, you decide, the export is permanent.",
  applicationName: "Anonify",
  icons: {
    icon: [{ url: "/Anonify.png", type: "image/png", sizes: "256x256" }],
    apple: [{ url: "/Anonify.png", sizes: "256x256" }],
  },
  openGraph: {
    title: "Anonify — AI-assisted document redaction",
    description:
      "Redact sensitive information without destroying the document. AI proposes, you decide, the export is permanent.",
    siteName: "Anonify",
    type: "website",
    // The JPEG has no alpha channel, which is what link previews want.
    images: [{ url: "/Anonify.jpeg", width: 256, height: 256, alt: "Anonify" }],
  },
  twitter: {
    card: "summary",
    title: "Anonify — AI-assisted document redaction",
    description:
      "Redact sensitive information without destroying the document.",
    images: ["/Anonify.jpeg"],
  },
}

/**
 * The metadata for this instance, with the preview images resolved against
 * its own address (`ANONIFY_PUBLIC_URL`). The root layout calls this per
 * request, so one image serves any address it is run at (#168).
 */
export function siteMetadata(
  env: Record<string, string | undefined> = process.env
): Metadata {
  return { ...STATIC_METADATA, metadataBase: publicUrl(env) }
}
