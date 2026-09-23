import { describe, expect, it } from "vitest"

import { historyWrites } from "@/store/history-sync"
import { makeStore } from "@/store/store"
import {
  redactionAdded,
  redactionMethodSet,
  redactionRemoved,
  redactionsReplaced,
  redactionStatusSet,
  redone,
  ruleAdded,
  ruleRemoved,
  undone,
} from "@/store/redactionSlice"
import {
  selectBulkTargets,
  selectCanRedo,
  selectCanUndo,
  selectCounts,
  selectOccurrenceGroups,
} from "@/store/selectors"
import type { Redaction } from "@/types/redaction"

function redaction(id: string, overrides: Partial<Redaction> = {}): Redaction {
  return {
    id,
    documentId: "doc_1",
    type: "text",
    source: "ai",
    category: "email",
    status: "suggested",
    text: "john@example.com",
    ...overrides,
  }
}

describe("undo and redo", () => {
  it("takes back an accept", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a")]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))
    expect(store.getState().redactions.entities.a.status).toBe("accepted")

    store.dispatch(undone())
    expect(store.getState().redactions.entities.a.status).toBe("suggested")
  })

  it("replays what was undone", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a")]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))
    store.dispatch(undone())
    store.dispatch(redone())

    expect(store.getState().redactions.entities.a.status).toBe("accepted")
  })

  it("takes back a manually created redaction", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([]))
    store.dispatch(redactionAdded(redaction("manual", { source: "user" })))
    expect(store.getState().redactions.ids).toEqual(["manual"])

    store.dispatch(undone())
    expect(store.getState().redactions.ids).toEqual([])
  })

  it("restores a removed redaction", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a")]))
    store.dispatch(redactionRemoved("a"))
    store.dispatch(undone())

    expect(store.getState().redactions.entities.a).toBeDefined()
  })

  it("drops the redo stack once a new edit is made", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a"), redaction("b")]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))
    store.dispatch(undone())
    expect(selectCanRedo(store.getState())).toBe(true)

    store.dispatch(redactionStatusSet({ ids: ["b"], status: "accepted" }))
    expect(selectCanRedo(store.getState())).toBe(false)
  })

  it("does not record a no-op status change", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a", { status: "accepted" })]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))

    expect(selectCanUndo(store.getState())).toBe(false)
  })

  it("treats a server reload as a fresh starting point", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a")]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))
    store.dispatch(redactionsReplaced([redaction("a")]))

    expect(selectCanUndo(store.getState())).toBe(false)
  })

  it("does not lose the user's history when suggestions stream in", () => {
    const store = makeStore()
    store.dispatch(redactionsReplaced([redaction("a")]))
    store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))

    expect(selectCanUndo(store.getState())).toBe(true)
  })
})

describe("inspector grouping", () => {
  it("groups occurrences of the same value into one decision", () => {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a", { page: 1 }),
        redaction("b", { page: 2 }),
        redaction("c", { text: "JOHN@EXAMPLE.COM", page: 3 }),
        redaction("d", { text: "Jane Doe", category: "person" }),
      ])
    )

    const groups = selectOccurrenceGroups(store.getState())
    expect(groups).toHaveLength(2)
    expect(groups[0].members).toHaveLength(3)
  })

  it("counts what has been accepted", () => {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a", { status: "accepted" }),
        redaction("b"),
        redaction("c", { status: "rejected" }),
      ])
    )

    expect(selectCounts(store.getState())).toEqual({
      total: 3,
      suggested: 1,
      accepted: 1,
      rejected: 1,
    })
  })
})

describe("global rules", () => {
  it("removes the redactions a rule created when the rule goes", () => {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a", { source: "rule", ruleId: "rule_1" }),
        redaction("b", { source: "rule", ruleId: "rule_1" }),
        redaction("c"),
      ])
    )
    store.dispatch(
      ruleAdded({
        id: "rule_1",
        documentId: "doc_1",
        pattern: "john@example.com",
        normalizedPattern: "john@example.com",
        category: "email",
        enabled: true,
      })
    )

    store.dispatch(ruleRemoved("rule_1"))

    expect(store.getState().redactions.ids).toEqual(["c"])
    expect(store.getState().redactions.ruleIds).toEqual([])
  })
})

describe("accept all", () => {
  it("leaves suggestions the reviewer ignored alone", () => {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a"),
        redaction("b", { text: "01632 960000", category: "phone" }),
        redaction("c", { text: "Dr Jane Doe", category: "person" }),
      ])
    )
    store.dispatch(redactionStatusSet({ ids: ["b"], status: "rejected" }))

    const targets = selectBulkTargets(store.getState())

    expect(targets.acceptIds.sort()).toEqual(["a", "c"])
    expect(targets.ignored).toBe(1)
    // Reject all is not asymmetric: it only ever takes redaction away.
    expect(targets.rejectIds.sort()).toEqual(["a", "b", "c"])
  })

  it("keeps an ignored suggestion ignored through an accept all", () => {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a"),
        redaction("b", { text: "01632 960000", category: "phone" }),
      ])
    )
    store.dispatch(redactionStatusSet({ ids: ["b"], status: "rejected" }))
    store.dispatch(
      redactionStatusSet({
        ids: selectBulkTargets(store.getState()).acceptIds,
        status: "accepted",
      })
    )

    expect(store.getState().redactions.entities.a.status).toBe("accepted")
    expect(store.getState().redactions.entities.b.status).toBe("rejected")
  })
})

/**
 * What an undo tells the server. It used to send every redaction's status,
 * which let one stray Ctrl+Z in a stale tab rewrite the whole document.
 */
describe("syncing a step through history", () => {
  function stepped(prepare: (store: ReturnType<typeof makeStore>) => void) {
    const store = makeStore()
    store.dispatch(
      redactionsReplaced([
        redaction("a"),
        redaction("b", { status: "accepted" }),
        redaction("c", { status: "rejected" }),
      ])
    )
    prepare(store)
    const before = store.getState().redactions.entities
    store.dispatch(undone())
    return historyWrites(before, store.getState().redactions.entities)
  }

  it("sends only the redactions the undo changed", () => {
    const writes = stepped((store) =>
      store.dispatch(redactionStatusSet({ ids: ["a"], status: "accepted" }))
    )
    expect(writes).toEqual([{ ids: ["a"], status: "suggested" }])
  })

  it("sends nothing when there was nothing to undo", () => {
    expect(stepped(() => {})).toEqual([])
  })

  it("puts a method back, including back to the default mask", () => {
    const writes = stepped((store) =>
      store.dispatch(redactionMethodSet({ ids: ["b"], method: "tokenize" }))
    )
    expect(writes).toEqual([{ ids: ["b"], method: "mask" }])
  })

  it("stops applying a redaction the undo took off the canvas", () => {
    const writes = stepped((store) =>
      store.dispatch(
        redactionAdded(redaction("manual", { source: "user", status: "accepted" }))
      )
    )
    expect(writes).toEqual([{ ids: ["manual"], status: "rejected" }])
  })
})
