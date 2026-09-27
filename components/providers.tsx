"use client"

import type { ReactNode } from "react"

import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ThemeProvider } from "@/components/theme-provider"
import { StoreProvider } from "@/store/provider"

export function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      forcedTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <StoreProvider>
        <TooltipProvider>{children}</TooltipProvider>
        {/* Bottom-centre, above the editor toolbar: bottom-right sat on
            Hush's message box and on the inspector's last actions. */}
        <Toaster position="bottom-center" offset={{ bottom: 64 }} />
      </StoreProvider>
    </ThemeProvider>
  )
}
