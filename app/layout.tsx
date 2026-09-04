import type { Metadata } from "next"
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
