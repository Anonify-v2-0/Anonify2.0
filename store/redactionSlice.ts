import { createSlice, current, type PayloadAction } from "@reduxjs/toolkit"

import type {
  GlobalRule,
  Redaction,
  RedactionMethod,
  RedactionSource,
  RedactionStatus,
} from "@/types/redaction"

export type RedactionFilters = {
  status: RedactionStatus | "all"
  source: RedactionSource | "all"
  category: string | "all"
}

/** The part of the state undo and redo move between. */
type Snapshot = {
  entities: Record<string, Redaction>
  ids: string[]
}

export type RedactionState = Snapshot & {
  rules: Record<string, GlobalRule>
  ruleIds: string[]
  selectedId: string | null
  filters: RedactionFilters
  past: Snapshot[]
  future: Snapshot[]
}

/** Deep enough history to undo a burst of accepts without unbounded growth. */
const HISTORY_LIMIT = 50

const initialState: RedactionState = {
  entities: {},
  ids: [],
  rules: {},
  ruleIds: [],
  selectedId: null,
  filters: { status: "all", source: "all", category: "all" },
  past: [],
  future: [],
}

/**
 * `current()` materializes the draft into plain values. Spreading the draft
 * directly would store references that the very next mutation edits, so an undo
 * would restore the state it was supposed to replace.
 */
function snapshot(state: RedactionState): Snapshot {
  const plain = current(state)
  return { entities: { ...plain.entities }, ids: [...plain.ids] }
}

/**
 * Records the state before a change so it can be undone. Every mutating
 * reducer calls this first — the history is the editor's memory, and a change
 * that skips it is a change the user cannot take back.
 */
function remember(state: RedactionState): void {
  state.past.push(snapshot(state))
  if (state.past.length > HISTORY_LIMIT) state.past.shift()
  state.future = []
}

const redactionSlice = createSlice({
  name: "redactions",
  initialState,
  reducers: {
    /** Replaces everything from the server. Not an undoable edit. */
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
      state.past = []
      state.future = []
    },
    redactionAdded(state, action: PayloadAction<Redaction>) {
      remember(state)
      const redaction = action.payload
      if (!state.entities[redaction.id]) state.ids.push(redaction.id)
      state.entities[redaction.id] = redaction
    },
    redactionsAdded(state, action: PayloadAction<Redaction[]>) {
      remember(state)
      for (const redaction of action.payload) {
        if (!state.entities[redaction.id]) state.ids.push(redaction.id)
        state.entities[redaction.id] = redaction
      }
    },
    /** Merges streamed suggestions in without disturbing the user's history. */
    suggestionsStreamed(state, action: PayloadAction<Redaction[]>) {
      for (const redaction of action.payload) {
        if (state.entities[redaction.id]) continue
        state.entities[redaction.id] = redaction
        state.ids.push(redaction.id)
      }
    },
    redactionUpdated(
      state,
      action: PayloadAction<{ id: string; changes: Partial<Redaction> }>
    ) {
      const existing = state.entities[action.payload.id]
      if (!existing) return
      remember(state)
      state.entities[action.payload.id] = { ...existing, ...action.payload.changes }
    },
    redactionRemoved(state, action: PayloadAction<string>) {
      if (!state.entities[action.payload]) return
      remember(state)
      delete state.entities[action.payload]
      state.ids = state.ids.filter((id) => id !== action.payload)
      if (state.selectedId === action.payload) state.selectedId = null
    },
    redactionStatusSet(
      state,
      action: PayloadAction<{ ids: string[]; status: RedactionStatus }>
    ) {
      const changing = action.payload.ids.filter(
        (id) => state.entities[id] && state.entities[id].status !== action.payload.status
      )
      if (changing.length === 0) return

      remember(state)
      for (const id of changing) {
        state.entities[id].status = action.payload.status
      }
    },
    /**
     * What accepting these will do to the bytes.
     *
     * Separate from the status because they are separate decisions: choosing
     * to pseudonymise a name is not choosing to redact it, and a reviewer
     * regularly does the first while still thinking about the second.
     */
    redactionMethodSet(
      state,
      action: PayloadAction<{ ids: string[]; method: RedactionMethod }>
    ) {
      const changing = action.payload.ids.filter(
        (id) =>
          state.entities[id] && state.entities[id].method !== action.payload.method
      )
      if (changing.length === 0) return

      remember(state)
      for (const id of changing) {
        state.entities[id].method = action.payload.method
      }
    },
    undone(state) {
      const previous = state.past.pop()
      if (!previous) return
      state.future.push(snapshot(state))
      state.entities = previous.entities
      state.ids = previous.ids
      if (state.selectedId && !state.entities[state.selectedId]) {
        state.selectedId = null
      }
    },
    redone(state) {
      const next = state.future.pop()
      if (!next) return
      state.past.push(snapshot(state))
      state.entities = next.entities
      state.ids = next.ids
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
    ruleToggled(state, action: PayloadAction<{ id: string; enabled: boolean }>) {
      const rule = state.rules[action.payload.id]
      if (rule) rule.enabled = action.payload.enabled
    },
    ruleRemoved(state, action: PayloadAction<string>) {
      delete state.rules[action.payload]
      state.ruleIds = state.ruleIds.filter((id) => id !== action.payload)
      // The redactions the rule created go with it.
      remember(state)
      for (const id of [...state.ids]) {
        if (state.entities[id]?.ruleId === action.payload) {
          delete state.entities[id]
          state.ids = state.ids.filter((candidate) => candidate !== id)
        }
      }
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
  suggestionsStreamed,
  redactionUpdated,
  redactionRemoved,
  redactionStatusSet,
  redactionMethodSet,
  undone,
  redone,
  redactionSelected,
  filtersChanged,
  ruleAdded,
  ruleToggled,
  ruleRemoved,
  redactionsCleared,
} = redactionSlice.actions

export default redactionSlice.reducer
