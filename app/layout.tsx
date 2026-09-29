import type { Metadata, Viewport } from "next"
import { Poppins } from "next/font/google"

import "./globals.css"
import { Providers } from "@/components/providers"
import { publicUrl } from "@/lib/config/public-url"

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

export const metadata: Metadata = {
  // What the preview images below are resolved against; see ANONIFY_PUBLIC_URL.
  metadataBase: publicUrl(),
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

export const viewport: Viewport = {
  // The workspace chrome is charcoal; match the browser UI to it.
  themeColor: "#212429",
  colorScheme: "dark",
  // Draw under the notch and the home indicator, and let each fixed control
  // step out of the way with env(safe-area-inset-*). Without this, iOS
  // reports every inset as zero and the bottom bar sits under the indicator.
  viewportFit: "cover",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`antialiased font-sans ${poppins.variable}`}
    >
      <body className="min-h-svh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
