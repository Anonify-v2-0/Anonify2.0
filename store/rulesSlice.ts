import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { RuleView } from "@/types/rules"

/**
 * The rules that reach the open document, at every scope, as the server last
 * described them. Not undoable and not optimistic: a rule reaches documents
 * the reviewer is not looking at, so the only honest copy is the server's,
 * reloaded after every change.
 */
type RulesState = {
  documentId: string | null
  items: RuleView[]
  status: "idle" | "loading" | "ready" | "error"
}

const initialState: RulesState = { documentId: null, items: [], status: "idle" }

const rulesSlice = createSlice({
  name: "rules",
  initialState,
  reducers: {
    rulesLoading(state, action: PayloadAction<string>) {
      if (state.documentId !== action.payload) state.items = []
      state.documentId = action.payload
      state.status = "loading"
    },
    rulesLoaded(
      state,
      action: PayloadAction<{ documentId: string; rules: RuleView[] }>
    ) {
      if (state.documentId !== action.payload.documentId) return
      state.items = action.payload.rules
      state.status = "ready"
    },
    rulesFailed(state) {
      state.status = "error"
    },
  },
})

export const { rulesLoading, rulesLoaded, rulesFailed } = rulesSlice.actions

export default rulesSlice.reducer
