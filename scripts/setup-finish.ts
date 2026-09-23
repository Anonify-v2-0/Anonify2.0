/**
 * The end of `pnpm setup`: what to run next, and — if you would rather not
 * copy it — running it.
 *
 * Two ways to run a local instance, and they must not be mixed. `docker
 * compose up -d` starts everything, the app included, on APP_PORT. Developing
 * with the app on the host means starting only its dependencies, because the
 * app container would otherwise already hold the port `pnpm dev` wants. The
 * first version of this ran the whole stack and then `pnpm dev`, which is a
 * guaranteed "port in use" presented as a finished setup.
 *
 * Every command is run only on an explicit choice, shown before it runs, and a
 * failure offers retry, skip or stop — never a silent carry-on and never a
 * dead end. Stopping prints exactly the commands that did not run.
 */

import { spawn } from "node:child_process"

import { bullet, note, ok, paint, Prompter, say, warn } from "./tty"

export type Mode = "local" | "demo"

export type Finish = {
  mode: Mode
  ocr: "tesseract" | "mistral"
  ports: { app: number }
}

type Step = {
  command: string
  done: string
  /** What usually went wrong, offered when it fails. */
  hint: string
}

/** Runs one shell command with the terminal, and says whether it succeeded. */
export type Runner = (
  command: string,
  options?: { quiet?: boolean }
) => Promise<boolean>

let children = 0

/**
 * True while a command started here is running. Ctrl-C then belongs to the
 * command — stopping `pnpm dev` is how you are meant to leave it — and setup's
 * own interrupt handler must not exit over the top of it.
 */
export function childRunning(): boolean {
  return children > 0
}

export const runShell: Runner = (command, { quiet = false } = {}) =>
  new Promise((resolve) => {
    // One string through the shell, not an argument list: `pnpm` and `docker`
    // resolve through .cmd shims on Windows, and every command here is built
    // from constants and port numbers, never from anything typed.
    const child = spawn(command, {
      stdio: quiet ? "ignore" : "inherit",
      shell: true,
    })
    children += 1
    const settle = (success: boolean) => {
      children -= 1
      resolve(success)
    }
    child.once("error", () => settle(false))
    child.once("exit", (code) => settle(code === 0))
  })

function appUrl({ ports }: Finish): string {
  return `http://localhost:${ports.app}`
}

function devCommand({ ports }: Finish): string {
  return ports.app === 3000 ? "pnpm dev" : `pnpm dev --port ${ports.app}`
}

const DOCKER_HINT = "Is Docker running? `docker info` should answer."

/** The app on this machine, its dependencies in Docker. */
export function hostSteps(finish: Finish): Step[] {
  return [
    {
      command: "docker compose up -d --wait postgres",
      done: "Postgres is running and healthy",
      hint: DOCKER_HINT,
    },
    {
      command: "docker compose up -d rustfs rustfs-init",
      done: "RustFS is running and the bucket exists",
      hint: DOCKER_HINT,
    },
    {
      // `migrate deploy`, not `migrate dev`: dev may offer to reset the
      // database or write a new migration, neither of which setup should do.
      command: "pnpm db:migrate:deploy",
      done: "Applied the database migrations",
      hint: "Postgres must be up, on the POSTGRES_PORT in .env.",
    },
    ...(finish.ocr === "tesseract"
      ? [
          {
            command: "pnpm ocr:warm",
            done: "Fetched the OCR model",
            hint: "It downloads from the network; the app can fetch it later instead.",
          },
        ]
      : []),
  ]
}

function dockerSteps(): Step[] {
  return [
    {
      command: "docker compose up -d",
      done: "Anonify is running in Docker",
      hint: DOCKER_HINT,
    },
  ]
}

/** What setup prints under "Next", whether or not it is then asked to run it. */
export function nextSteps(finish: Finish): string[] {
  const column = (command: string, comment: string) =>
    `${command.padEnd(52)} # ${comment}`
  if (finish.mode === "demo") {
    return [
      "Fill in the REQUIRED values in .env",
      column("pnpm db:migrate", "apply the schema to your Neon database"),
      column(devCommand(finish), appUrl(finish)),
    ]
  }
  return [
    "Everything in Docker:",
    column("  docker compose up -d", `the app too, on ${appUrl(finish)}`),
    "Or the app on this machine, for development:",
    column("  docker compose up -d postgres rustfs rustfs-init", "services"),
    column("  pnpm db:migrate", "apply the schema"),
    ...(finish.ocr === "tesseract"
      ? [column("  pnpm ocr:warm", "fetch the OCR model now")]
      : []),
    column(`  ${devCommand(finish)}`, appUrl(finish)),
  ]
}

async function dockerReady(prompt: Prompter, run: Runner): Promise<boolean> {
  for (;;) {
    if (await run("docker info", { quiet: true })) return true
    warn("Docker is not answering. Start Docker (or install it), then retry.")
    const next = await prompt.choose("Docker is not running", [
      { value: "retry", label: "Check again" },
      { value: "stop", label: "Stop here; I will run the steps myself" },
    ])
    if (next === "stop") return false
  }
}

function remaining(commands: string[]): void {
  say()
  note("Pick up where this stopped:")
  for (const command of commands) bullet(paint.bold(command))
}

/**
 * Offers to run the next steps. Returns without asking anything when there is
 * nobody to ask: a scripted setup writes .env and stops, as it always has.
 */
export async function finishSetup(
  prompt: Prompter,
  finish: Finish,
  run: Runner = runShell
): Promise<void> {
  if (!prompt.interactive || finish.mode !== "local") return

  const action = await prompt.choose("Run the next steps now?", [
    {
      value: "print",
      label: "No, I will run them myself",
      detail: ["Nothing is started. The commands are above."],
    },
    {
      value: "host",
      label: "Prepare this machine for development",
      detail: [
        `Postgres and RustFS in Docker, then the database migrations${finish.ocr === "tesseract" ? " and the OCR model" : ""}.`,
      ],
    },
    {
      value: "dev",
      label: "Prepare this machine, then start the app",
      detail: [
        `The same, then ${devCommand(finish)} on ${appUrl(finish)}. Ctrl-C stops it.`,
      ],
    },
    {
      value: "docker",
      label: "Run everything in Docker",
      detail: [
        `docker compose up -d, serving ${appUrl(finish)}.`,
        "The first run builds the app image, which takes a few minutes.",
      ],
    },
  ])
  if (action === "print") return

  const plan = action === "docker" ? dockerSteps() : hostSteps(finish)
  const after = action === "dev" ? [devCommand(finish)] : []
  if (!(await dockerReady(prompt, run))) {
    remaining([...plan.map((step) => step.command), ...after])
    return
  }

  const skipped: Step[] = []
  for (let index = 0; index < plan.length;) {
    const step = plan[index]
    say()
    note(`$ ${step.command}`)
    if (await prompt.handOff(() => run(step.command))) {
      ok(step.done)
      index += 1
      continue
    }
    warn(`${step.command} failed. ${step.hint}`)
    const next = await prompt.choose("What now?", [
      { value: "retry", label: "Try it again" },
      { value: "skip", label: "Skip it and carry on" },
      { value: "stop", label: "Stop here" },
    ])
    if (next === "retry") continue
    if (next === "skip") {
      skipped.push(step)
      index += 1
      continue
    }
    remaining([
      ...plan.slice(index).map((entry) => entry.command),
      ...skipped.map((entry) => entry.command),
      ...after,
    ])
    return
  }

  if (skipped.length > 0) {
    say()
    warn("Skipped, and still to run before the app will work:")
    for (const step of skipped) bullet(paint.bold(step.command))
  }

  say()
  if (action === "docker") {
    ok(`Anonify is starting on ${appUrl(finish)}`)
    note("Follow it with `docker compose logs -f app`; stop it with")
    note("`docker compose down`.")
  } else if (action === "host") {
    note(`Start the app whenever you are ready: ${devCommand(finish)}`)
  } else {
    note(`Starting the app on ${appUrl(finish)}. Ctrl-C stops it.`)
    await prompt.handOff(() => run(devCommand(finish)))
    say()
    note(`The app stopped. Start it again with: ${devCommand(finish)}`)
  }
}
