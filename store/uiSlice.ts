import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

import type { PatternSpec } from "@/lib/redaction/patterns"
import type { RuleScope, RuleView } from "@/types/rules"

/**
 * What the rule dialog was opened to do.
 *
 * `create` arrives pre-filled from wherever the decision started — a search's
 * "Redact all matches", a Hush proposal, the rules panel — and `edit` carries
 * the rule being changed, so the dialog can re-preview before replacing it.
 */
export type RuleDialogRequest =
  | {
      mode: "create"
      spec: PatternSpec
      category: string
      scope: RuleScope
      /** Why this scope was suggested, when something suggested it. */
      scopeReason?: string
    }
  | { mode: "edit"; rule: RuleView }

/** What Hush was opened to do; `improve` names the RegEx rule to improve. */
export type AssistantRequest = { mode: "ask" } | { mode: "improve"; rule: RuleView }

type UiState = {
  exportDialogOpen: boolean
  shortcutsOpen: boolean
  mobileSheetOpen: boolean
  pagePanelOpen: boolean
  /** The right rail's tab. */
  inspectorTab: "redactions" | "rules"
  ruleDialog: RuleDialogRequest | null
  assistant: AssistantRequest | null
  /** Learned shapes the reviewer said "not now" to, by pattern. */
  hushDismissed: string[]
}

const initialState: UiState = {
  exportDialogOpen: false,
  shortcutsOpen: false,
  mobileSheetOpen: false,
  pagePanelOpen: true,
  inspectorTab: "redactions",
  ruleDialog: null,
  assistant: null,
  hushDismissed: [],
}

const uiSlice = createSlice({
  name: "ui",
  initialState,
  reducers: {
    exportDialogToggled(state, action: PayloadAction<boolean | undefined>) {
      state.exportDialogOpen = action.payload ?? !state.exportDialogOpen
    },
    shortcutsToggled(state, action: PayloadAction<boolean | undefined>) {
      state.shortcutsOpen = action.payload ?? !state.shortcutsOpen
    },
    mobileSheetToggled(state, action: PayloadAction<boolean | undefined>) {
      state.mobileSheetOpen = action.payload ?? !state.mobileSheetOpen
    },
    pagePanelToggled(state, action: PayloadAction<boolean | undefined>) {
      state.pagePanelOpen = action.payload ?? !state.pagePanelOpen
    },
    inspectorTabChanged(state, action: PayloadAction<UiState["inspectorTab"]>) {
      state.inspectorTab = action.payload
    },
    ruleDialogOpened(state, action: PayloadAction<RuleDialogRequest>) {
      state.ruleDialog = action.payload
    },
    ruleDialogClosed(state) {
      state.ruleDialog = null
    },
    hushOfferDismissed(state, action: PayloadAction<string>) {
      if (!state.hushDismissed.includes(action.payload)) {
        state.hushDismissed.push(action.payload)
      }
    },
    /** Opens Hush, or closes it when it is already open for the same thing. */
    assistantToggled(state, action: PayloadAction<AssistantRequest | null | undefined>) {
      if (action.payload === undefined) {
        state.assistant = state.assistant ? null : { mode: "ask" }
      } else {
        state.assistant = action.payload
      }
    },
  },
})

export const {
  exportDialogToggled,
  shortcutsToggled,
  mobileSheetToggled,
  pagePanelToggled,
  inspectorTabChanged,
  ruleDialogOpened,
  ruleDialogClosed,
  assistantToggled,
  hushOfferDismissed,
} = uiSlice.actions

export default uiSlice.reducer
