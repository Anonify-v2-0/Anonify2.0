import { afterEach, expect, it, vi } from "vitest"

import { bannerLines, setupVersion } from "../scripts/setup-banner"
import {
  finishSetup,
  hostSteps,
  nextSteps,
  type Finish,
  type Runner,
} from "../scripts/setup-finish"
import { Prompter, setColor } from "../scripts/tty"

afterEach(() => {
  vi.restoreAllMocks()
})

const local: Finish = { mode: "local", ocr: "tesseract", ports: { app: 3000 } }

/** Answers menus by label, so a test reads as the choices somebody made. */
function prompter(answers: string[], interactive = true) {
  setColor(false)
  const output: string[] = []
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output.push(String(chunk))
    return true
  })
  const choose = vi.fn(
    async (_question: string, choices: { value: unknown; label: string }[]) => {
      const answer = answers.shift()
      const choice = choices.find((entry) => entry.label.startsWith(answer!))
      if (!choice) throw new Error(`no choice starts with "${answer}"`)
      return choice.value
    }
  )
  const handOff = vi.fn(async (run: () => Promise<unknown>) => run())
  const prompt = { interactive, choose, handOff } as unknown as Prompter
  return { prompt, choose, handOff, output: () => output.join("") }
}

/** Every command succeeds, except the ones named, the given number of times. */
function runner(failures: Record<string, number> = {}) {
  const commands: string[] = []
  const run: Runner = async (command) => {
    commands.push(command)
    if ((failures[command] ?? 0) > 0) {
      failures[command] -= 1
      return false
    }
    return true
  }
  return { run, commands }
}

it("asks nothing and runs nothing when setup is scripted", async () => {
  const { prompt, choose } = prompter([], false)
  const { run, commands } = runner()
  await finishSetup(prompt, local, run)
  expect(choose).not.toHaveBeenCalled()
  expect(commands).toEqual([])
})

it("does not offer to run a demo-compatible setup it cannot finish", async () => {
  const { prompt, choose } = prompter([])
  const { run, commands } = runner()
  await finishSetup(prompt, { ...local, mode: "demo" }, run)
  expect(choose).not.toHaveBeenCalled()
  expect(commands).toEqual([])
})

it("prints only, by default", async () => {
  const { prompt } = prompter(["No, I will run them myself"])
  const { run, commands } = runner()
  await finishSetup(prompt, local, run)
  expect(commands).toEqual([])
})

it("prepares the host without starting the app container, then runs pnpm dev", async () => {
  const { prompt, handOff } = prompter(["Prepare this machine, then start"])
  const { run, commands } = runner()
  await finishSetup(prompt, { ...local, ports: { app: 3001 } }, run)
  expect(commands).toEqual([
    "docker info",
    "docker compose up -d --wait postgres",
    "docker compose up -d rustfs rustfs-init",
    "pnpm db:migrate:deploy",
    "pnpm ocr:warm",
    "pnpm dev --port 3001",
  ])
  // A bare `docker compose up -d` would start the app on the port pnpm dev needs.
  expect(commands).not.toContain("docker compose up -d")
  // Every command that inherits the terminal gets it handed over.
  expect(handOff).toHaveBeenCalledTimes(5)
})

it("skips warming Tesseract when OCR is hosted", () => {
  expect(
    hostSteps({ ...local, ocr: "mistral" }).map((step) => step.command)
  ).not.toContain("pnpm ocr:warm")
})

it("runs the whole stack in Docker when asked, and nothing on the host", async () => {
  const { prompt, output } = prompter(["Run everything in Docker"])
  const { run, commands } = runner()
  await finishSetup(prompt, local, run)
  expect(commands).toEqual(["docker info", "docker compose up -d"])
  expect(output()).toContain("http://localhost:3000")
})

it("retries a failed step", async () => {
  const { prompt } = prompter([
    "Prepare this machine for development",
    "Try it again",
  ])
  const { run, commands } = runner({ "pnpm db:migrate:deploy": 1 })
  await finishSetup(prompt, local, run)
  expect(commands.filter((c) => c === "pnpm db:migrate:deploy")).toHaveLength(2)
  expect(commands.at(-1)).toBe("pnpm ocr:warm")
})

it("skips a failed step, carries on and says what is still to run", async () => {
  const { prompt, output } = prompter([
    "Prepare this machine for development",
    "Skip it",
  ])
  const { run, commands } = runner({ "pnpm ocr:warm": 1 })
  await finishSetup(prompt, local, run)
  expect(commands.at(-1)).toBe("pnpm ocr:warm")
  expect(output()).toContain("Skipped, and still to run")
})

it("stops on request and prints exactly the commands that did not run", async () => {
  const { prompt, output } = prompter([
    "Prepare this machine, then start",
    "Stop here",
  ])
  const { run, commands } = runner({
    "docker compose up -d rustfs rustfs-init": 1,
  })
  await finishSetup(prompt, local, run)
  expect(commands).not.toContain("pnpm db:migrate:deploy")
  const printed = output().slice(output().indexOf("Pick up where this stopped"))
  expect(printed).toContain("docker compose up -d rustfs rustfs-init")
  expect(printed).toContain("pnpm db:migrate:deploy")
  expect(printed).toContain("pnpm dev")
  expect(printed).not.toContain("--wait postgres")
})

it("waits for Docker to be started rather than failing every step", async () => {
  const { prompt } = prompter(["Run everything in Docker", "Check again"])
  const { run, commands } = runner({ "docker info": 1 })
  await finishSetup(prompt, local, run)
  expect(commands).toEqual([
    "docker info",
    "docker info",
    "docker compose up -d",
  ])
})

it("prints both local paths without mixing them", () => {
  const lines = nextSteps({ ...local, ports: { app: 3005 } }).join("\n")
  expect(lines).toContain("docker compose up -d postgres rustfs rustfs-init")
  expect(lines).toContain("pnpm dev --port 3005")
  expect(lines).toContain("http://localhost:3005")
  expect(nextSteps({ ...local, ocr: "mistral" }).join("\n")).not.toContain(
    "ocr:warm"
  )
})

it("draws a square banner, and plain lines when there is no terminal", () => {
  setColor(false)
  const fancy = bannerLines({ version: "9.9.9", fancy: true })
  const frame = fancy.map((line) => line.match(/[┌│└].*[┐│┘]/u)![0])
  expect(new Set(frame.map((row) => [...row].length)).size).toBe(1)
  expect(fancy.join("\n")).toContain("v9.9.9")

  const plain = bannerLines({ version: "9.9.9", fancy: false })
  expect(plain).toHaveLength(3)
  expect(plain.join("\n")).not.toMatch(/[┌│└█]/u)
  expect(plain.join("\n")).toContain("v9.9.9")
})

it("reads the version beside the script, not from the working directory", () => {
  const cwd = vi.spyOn(process, "cwd").mockReturnValue("/nowhere")
  expect(setupVersion()).toMatch(/^\d+\.\d+\.\d+/)
  cwd.mockRestore()
})
