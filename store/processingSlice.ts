import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import {
  statusProgress,
  type ProcessingEvent,
  type ProcessingStatus,
} from "@/types/processing"

type ProcessingState = {
  status: ProcessingStatus
  progress: number
  events: ProcessingEvent[]
  suggestionCount: number
  error: string | null
}

const initialState: ProcessingState = {
  status: "queued",
  progress: 0,
  events: [],
  suggestionCount: 0,
  error: null,
}

/** Keeps the event log bounded; the inspector only ever renders the tail. */
const MAX_EVENTS = 200

const processingSlice = createSlice({
  name: "processing",
  initialState,
  reducers: {
    statusChanged(state, action: PayloadAction<ProcessingStatus>) {
      state.status = action.payload
      state.progress = statusProgress(action.payload)
      if (action.payload !== "failed") state.error = null
    },
    progressChanged(state, action: PayloadAction<number>) {
      state.progress = Math.min(100, Math.max(0, action.payload))
    },
    eventReceived(state, action: PayloadAction<ProcessingEvent>) {
      state.events.push(action.payload)
      if (state.events.length > MAX_EVENTS) state.events.shift()
    },
    suggestionCountChanged(state, action: PayloadAction<number>) {
      state.suggestionCount = action.payload
    },
    processingFailed(state, action: PayloadAction<string>) {
      state.status = "failed"
      state.error = action.payload
    },
    processingReset() {
      return initialState
    },
  },
})

export const {
  statusChanged,
  progressChanged,
  eventReceived,
  suggestionCountChanged,
  processingFailed,
  processingReset,
} = processingSlice.actions

export default processingSlice.reducer
