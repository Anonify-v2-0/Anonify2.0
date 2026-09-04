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
        <Toaster position="bottom-right" />
      </StoreProvider>
    </ThemeProvider>
  )
}
