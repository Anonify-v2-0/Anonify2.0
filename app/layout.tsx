import type { Metadata, Viewport } from "next"
import { Poppins } from "next/font/google"

import { connection } from "next/server"

import "./globals.css"
import { Providers } from "@/components/providers"
import { siteMetadata } from "@/lib/config/site-metadata"

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

/**
 * Resolved per request, not at build: the preview images are resolved against
 * ANONIFY_PUBLIC_URL, and an image built once is run at many addresses. A
 * static `metadata` export read it when `next build` ran, so every published
 * image would have carried http://localhost:3000 (#168). This makes the
 * prerendered pages (/, /about, /restore) render on demand, which costs a few
 * milliseconds a view.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection()
  return siteMetadata()
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
      className={`font-sans antialiased ${poppins.variable}`}
    >
      <body className="min-h-svh bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)] text-foreground">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
