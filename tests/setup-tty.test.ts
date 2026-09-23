import { afterEach, expect, it, vi } from "vitest"

import { Prompter, setColor, type Choice, type PagedView } from "../scripts/tty"

afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * A real Prompter reading scripted answers. Built without its constructor so
 * no readline interface is opened on the test runner's stdin.
 */
function scripted(answers: string[]) {
  setColor(false)
  const output: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  const prompt = Object.create(Prompter.prototype) as Prompter
  Object.assign(prompt, {
    interactive: true,
    read: async () => {
      if (answers.length === 0) throw new Error("ran out of answers")
      return answers.shift()!
    },
  })
  return { prompt, output: () => output.join("") }
}

const models: Choice<string>[] = Array.from({ length: 120 }, (_, index) => ({
  value: `model-${String(index).padStart(3, "0")}`,
  label: `model-${String(index).padStart(3, "0")}`,
}))
models.push(
  { value: "gpt-4o", label: "gpt-4o" },
  { value: "gpt-4.1", label: "gpt-4.1" }
)

const actions: Choice<string>[] = [
  { value: "manual", label: "Enter a model ID" },
  { value: "cancel", label: "Keep the current configuration" },
]

it("pages a large list without printing all of it", async () => {
  // Page 1: eight models, then 9 Next, 10 Search, 11–12 the actions.
  const { prompt, output } = scripted(["9", "3"])
  const picked = await prompt.choosePaged("Which model?", models, {
    noun: "models",
    pageSize: 8,
    actions,
  })
  expect(picked).toBe("model-010")
  const printed = output()
  expect(printed).toContain("122 models · page 1 of 16")
  expect(printed).toContain("122 models · page 2 of 16")
  expect(printed).not.toContain("model-100")
  expect(printed).toContain("Previous page")
})

it("keeps the escape hatches on every page and through a search", async () => {
  // Search "gpt": two matches, then Search again, Clear, and the two actions.
  const { prompt, output } = scripted(["10", "gpt", "6"])
  const picked = await prompt.choosePaged("Which model?", models, {
    noun: "models",
    pageSize: 8,
    actions,
  })
  expect(picked).toBe("cancel")
  expect(output()).toContain('2 of 122 models match "gpt" · page 1 of 1')
  expect(output()).toContain("Clear the search and show all 122 models")
})

it("clears a search back to the whole list", async () => {
  const { prompt, output } = scripted(["10", "gpt", "4", "1"])
  const picked = await prompt.choosePaged("Which model?", models, {
    noun: "models",
    pageSize: 8,
    actions,
  })
  expect(picked).toBe("model-000")
  expect(output().match(/122 models · page 1 of 16/g)).toHaveLength(2)
})

it("says when nothing matches and still offers a way out", async () => {
  const { prompt, output } = scripted(["10", "claude", "3"])
  const picked = await prompt.choosePaged("Which model?", models, {
    noun: "models",
    pageSize: 8,
    actions,
  })
  expect(output()).toContain('No models match "claude"')
  expect(output()).toContain('0 of 122 models match "claude"')
  expect(picked).toBe("manual")
})

it("opens on the page of the initial choice and makes it the default", async () => {
  const { prompt, output } = scripted([""])
  const picked = await prompt.choosePaged("Which model?", models, {
    noun: "models",
    pageSize: 8,
    initial: "model-042",
  })
  expect(picked).toBe("model-042")
  expect(output()).toContain("page 6 of 16")
})

it("remembers the page and search across calls that share a view", async () => {
  const view: PagedView = { search: "" }
  const first = scripted(["10", "model-0", "9", "1"])
  expect(
    await first.prompt.choosePaged("Which model?", models, {
      noun: "models",
      pageSize: 8,
      actions,
      view,
    })
  ).toBe("model-008")
  expect(view).toEqual({ search: "model-0", page: 1 })

  vi.restoreAllMocks()
  const second = scripted(["2"])
  expect(
    await second.prompt.choosePaged("Which model?", models, {
      noun: "models",
      pageSize: 8,
      actions,
      view,
    })
  ).toBe("model-009")
  expect(second.output()).toContain('100 of 122 models match "model-0"')
})

it("searches what it is told to, not the label alone", async () => {
  const named: Choice<string>[] = [
    { value: "a", label: "vendor/a", detail: ["images yes"] },
    { value: "b", label: "vendor/b", detail: ["images no"] },
  ]
  // Nothing matches: 1 Search again, 2 Clear, 3 the first action.
  const { prompt, output } = scripted(["3", "images", "3"])
  const picked = await prompt.choosePaged("Which model?", named, {
    noun: "models",
    searchText: (choice) => choice.label,
    actions,
  })
  // "images" appears only in the details, so nothing matches.
  expect(output()).toContain('0 of 2 models match "images"')
  expect(picked).toBe("manual")
})

it("answers from the initial choice without asking when not interactive", async () => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true)
  const prompt = new Prompter(false)
  const read = vi.spyOn(
    prompt as unknown as { read: () => Promise<string> },
    "read"
  )
  expect(
    await prompt.choosePaged("Which model?", models, { initial: "gpt-4o" })
  ).toBe("gpt-4o")
  expect(
    await prompt.choosePaged(
      "Which model?",
      [{ value: "x", label: "x", disabled: "no" }, ...models],
      {}
    )
  ).toBe("model-000")
  expect(read).not.toHaveBeenCalled()
})
