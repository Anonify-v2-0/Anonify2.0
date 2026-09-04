import { configureStore } from "@reduxjs/toolkit"

import documentReducer from "./documentSlice"
import editorReducer from "./editorSlice"
import processingReducer from "./processingSlice"
import redactionReducer from "./redactionSlice"
import uiReducer from "./uiSlice"

export const rootReducer = {
  document: documentReducer,
  redactions: redactionReducer,
  editor: editorReducer,
  processing: processingReducer,
  ui: uiReducer,
}

export function makeStore() {
  return configureStore({ reducer: rootReducer })
}

export type AppStore = ReturnType<typeof makeStore>
export type RootState = ReturnType<AppStore["getState"]>
export type AppDispatch = AppStore["dispatch"]
