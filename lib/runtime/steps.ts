/**
 * The workflow steps this process is running right now (#182).
 *
 * Every step the job runner executes is delivered to this server through the
 * loopback relay (lib/security/workflow-relay.ts), with the step's name and
 * attempt in its headers. The relay records each one here as it starts and
 * finishes, so every step is counted, including ones written later, without
 * any of them having to remember to report itself. Nothing here reads a
 * step's payload: a name, an attempt and a start time are all it knows.
 *
 * Used by the shutdown sequence, to say what was still running when its
 * deadline passed, and by the metrics (#188), through `onStepFinished`.
 */

export type StepOutcome = "completed" | "retry" | "error"

export type RunningStep = {
  /** The step function's name, e.g. `extractAndNormalize`. */
  step: string
  attempt: number
  startedAt: number
}

export type FinishedStep = RunningStep & {
  outcome: StepOutcome
  durationMs: number
}

type StepRegistry = {
  running: Set<RunningStep>
  finished: Set<(step: FinishedStep) => void>
  started: Set<(step: RunningStep) => void>
}

const shared = globalThis as unknown as { anonifySteps?: StepRegistry }

function registry(): StepRegistry {
  shared.anonifySteps ??= {
    running: new Set(),
    finished: new Set(),
    started: new Set(),
  }
  return shared.anonifySteps
}

const STEP_QUEUE_PREFIX = "__wkf_step_"

/**
 * The step's own name from the queue it was delivered from:
 * `__wkf_step_step//./lib/workflows/process-document//analyze` is `analyze`.
 * Undefined for anything that is not a step (a workflow invocation).
 */
export function stepNameFromQueue(
  queueName: string | undefined
): string | undefined {
  if (!queueName) return undefined
  const at = queueName.indexOf(STEP_QUEUE_PREFIX)
  if (at === -1) return undefined
  const id = queueName.slice(at + STEP_QUEUE_PREFIX.length)
  const name = id.split("//").pop()?.trim()
  // Only an identifier ever leaves here: it becomes a log field and a metric
  // label, so nothing that could carry anything else is passed through.
  return name && /^[A-Za-z_$][\w$]{0,99}$/.test(name) ? name : "unknown"
}

/** Records a step starting; the returned function records it finishing. */
export function stepStarted(
  step: string,
  attempt: number,
  now: () => number = Date.now
): (outcome: StepOutcome) => void {
  const entry: RunningStep = {
    step,
    attempt: Number.isFinite(attempt) && attempt > 0 ? attempt : 1,
    startedAt: now(),
  }
  registry().running.add(entry)
  for (const listener of registry().started) listener(entry)

  let done = false
  return (outcome) => {
    if (done) return
    done = true
    registry().running.delete(entry)
    const finished = { ...entry, outcome, durationMs: now() - entry.startedAt }
    for (const listener of registry().finished) listener(finished)
  }
}

/** What is running now, oldest first. */
export function stepsInFlight(): RunningStep[] {
  return [...registry().running].sort((a, b) => a.startedAt - b.startedAt)
}

export function onStepStarted(
  listener: (step: RunningStep) => void
): () => void {
  registry().started.add(listener)
  return () => registry().started.delete(listener)
}

export function onStepFinished(
  listener: (step: FinishedStep) => void
): () => void {
  registry().finished.add(listener)
  return () => registry().finished.delete(listener)
}

/** For tests. */
export function resetSteps(): void {
  shared.anonifySteps = undefined
}
