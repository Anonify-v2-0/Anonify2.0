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
            Hush's message box and on the inspector's last actions. On a
            phone, above the action bar and the page stepper, where a toast
            used to cover the bar and swallow the next tap on it. */}
        <Toaster
          position="bottom-center"
          offset={{ bottom: 64 }}
          mobileOffset={{ bottom: "calc(7.5rem + env(safe-area-inset-bottom))" }}
        />
      </StoreProvider>
    </ThemeProvider>
  )
}
