import type { Metadata, Viewport } from "next"
import { Poppins } from "next/font/google"

import "./globals.css"
import { Providers } from "@/components/providers"

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

export const metadata: Metadata = {
  title: "Anonify — AI-assisted document redaction",
  description:
    "Redact sensitive information from PDF, DOCX, XLSX and image files without destroying the document. AI proposes, you decide, the export is permanent.",
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
      <body className="min-h-svh bg-background text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
