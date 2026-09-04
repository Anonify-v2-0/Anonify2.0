import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type {
  GlobalRule,
  Redaction,
  RedactionSource,
  RedactionStatus,
} from "@/types/redaction"

export type RedactionFilters = {
  status: RedactionStatus | "all"
  source: RedactionSource | "all"
  category: string | "all"
}

export type RedactionState = {
  entities: Record<string, Redaction>
  ids: string[]
  rules: Record<string, GlobalRule>
  ruleIds: string[]
  selectedId: string | null
  filters: RedactionFilters
}

const initialState: RedactionState = {
  entities: {},
  ids: [],
  rules: {},
  ruleIds: [],
  selectedId: null,
  filters: { status: "all", source: "all", category: "all" },
}

const redactionSlice = createSlice({
  name: "redactions",
  initialState,
  reducers: {
    redactionsReplaced(state, action: PayloadAction<Redaction[]>) {
      state.entities = {}
      state.ids = []
      for (const redaction of action.payload) {
        state.entities[redaction.id] = redaction
        state.ids.push(redaction.id)
      }
      if (state.selectedId && !state.entities[state.selectedId]) {
        state.selectedId = null
      }
    },
    redactionAdded(state, action: PayloadAction<Redaction>) {
      const redaction = action.payload
      if (!state.entities[redaction.id]) state.ids.push(redaction.id)
      state.entities[redaction.id] = redaction
    },
    redactionsAdded(state, action: PayloadAction<Redaction[]>) {
      for (const redaction of action.payload) {
        if (!state.entities[redaction.id]) state.ids.push(redaction.id)
        state.entities[redaction.id] = redaction
      }
    },
    redactionUpdated(
      state,
      action: PayloadAction<{ id: string; changes: Partial<Redaction> }>
    ) {
      const existing = state.entities[action.payload.id]
      if (existing) {
        state.entities[action.payload.id] = { ...existing, ...action.payload.changes }
      }
    },
    redactionRemoved(state, action: PayloadAction<string>) {
      delete state.entities[action.payload]
      state.ids = state.ids.filter((id) => id !== action.payload)
      if (state.selectedId === action.payload) state.selectedId = null
    },
    redactionStatusSet(
      state,
      action: PayloadAction<{ ids: string[]; status: RedactionStatus }>
    ) {
      for (const id of action.payload.ids) {
        const redaction = state.entities[id]
        if (redaction) redaction.status = action.payload.status
      }
    },
    redactionSelected(state, action: PayloadAction<string | null>) {
      state.selectedId = action.payload
    },
    filtersChanged(state, action: PayloadAction<Partial<RedactionFilters>>) {
      state.filters = { ...state.filters, ...action.payload }
    },
    ruleAdded(state, action: PayloadAction<GlobalRule>) {
      if (!state.rules[action.payload.id]) state.ruleIds.push(action.payload.id)
      state.rules[action.payload.id] = action.payload
    },
    ruleToggled(
      state,
      action: PayloadAction<{ id: string; enabled: boolean }>
    ) {
      const rule = state.rules[action.payload.id]
      if (rule) rule.enabled = action.payload.enabled
    },
    ruleRemoved(state, action: PayloadAction<string>) {
      delete state.rules[action.payload]
      state.ruleIds = state.ruleIds.filter((id) => id !== action.payload)
    },
    redactionsCleared() {
      return initialState
    },
  },
})

export const {
  redactionsReplaced,
  redactionAdded,
  redactionsAdded,
  redactionUpdated,
  redactionRemoved,
  redactionStatusSet,
  redactionSelected,
  filtersChanged,
  ruleAdded,
  ruleToggled,
  ruleRemoved,
  redactionsCleared,
} = redactionSlice.actions

export default redactionSlice.reducer
