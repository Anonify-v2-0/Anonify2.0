import { createSlice, type PayloadAction } from "@reduxjs/toolkit"

type UiState = {
  exportDialogOpen: boolean
  shortcutsOpen: boolean
  mobileSheetOpen: boolean
  pagePanelOpen: boolean
}

const initialState: UiState = {
  exportDialogOpen: false,
  shortcutsOpen: false,
  mobileSheetOpen: false,
  pagePanelOpen: true,
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
  },
})

export const {
  exportDialogToggled,
  shortcutsToggled,
  mobileSheetToggled,
  pagePanelToggled,
} = uiSlice.actions

export default uiSlice.reducer
