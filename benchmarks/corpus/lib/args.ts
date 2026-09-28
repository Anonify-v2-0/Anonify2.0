/**
 * A whole-number command-line option, or an error naming it.
 *
 * `Number()` alone turns `10m` or `x` into NaN, which then passes silently
 * through arithmetic: a NaN timeout fires at once and a NaN concurrency starts
 * no workers. Digits only, so `1e3`, `0x10` and `-1` are refused as well.
 */
export function int(name: string, value: string, min = 0): number {
  const parsed = /^\d+$/.test(value.trim()) ? Number(value) : NaN
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new Error(
      `--${name} must be a whole number${min > 0 ? ` of at least ${min}` : ""}, not ${JSON.stringify(value)}`
    )
  }
  return parsed
}
