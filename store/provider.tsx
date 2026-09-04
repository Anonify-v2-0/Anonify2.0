"use client"

import { useState, type ReactNode } from "react"
import { Provider } from "react-redux"

import { makeStore } from "./store"

export function StoreProvider({ children }: { children: ReactNode }) {
  // One store per browser session, created lazily so the server render and the
  // client hydration never share mutable state.
  const [store] = useState(makeStore)

  return <Provider store={store}>{children}</Provider>
}
