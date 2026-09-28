/**
 * Charts as SVG, drawn by hand so they need no dependency and render the
 * same on GitHub, in an editor and in a browser.
 *
 * Every chart is drawn twice, once per theme, from the same data: the dark
 * one is its own set of steps chosen for a dark surface, not the light one
 * inverted. The categorical order and the steps are a validated palette:
 * adjacent series stay apart under the three common colour-vision
 * deficiencies, and identity never rests on colour alone, because every
 * series with a colour also has a legend entry, a direct label, or both, and
 * the README carries the numbers as a table beside each chart.
 *
 * Marks follow one set of rules: bars at most 24px thick with a rounded data
 * end and a square baseline, 2px lines, 8px markers with a ring in the
 * surface colour, hairline solid gridlines, text in ink rather than in the
 * series colour.
 */

export type Theme = {
  name: "light" | "dark"
  surface: string
  surfaceSunken: string
  ink: string
  inkSecondary: string
  muted: string
  grid: string
  axis: string
  border: string
  series: string[]
  /** Sequential blue, from "nothing" (close to the surface) to "all". */
  sequential: string[]
}

const BLUE = [
  "#cde2fb",
  "#b7d3f6",
  "#9ec5f4",
  "#86b6ef",
  "#6da7ec",
  "#5598e7",
  "#3987e5",
  "#2a78d6",
  "#256abf",
  "#1c5cab",
  "#184f95",
  "#104281",
  "#0d366b",
]

export const LIGHT: Theme = {
  name: "light",
  surface: "#fcfcfb",
  surfaceSunken: "#f0efec",
  ink: "#0b0b0b",
  inkSecondary: "#52514e",
  muted: "#898781",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  border: "rgba(11,11,11,0.10)",
  series: [
    "#2a78d6",
    "#eb6834",
    "#1baf7a",
    "#eda100",
    "#e87ba4",
    "#008300",
    "#4a3aa7",
    "#e34948",
  ],
  sequential: BLUE,
}

export const DARK: Theme = {
  name: "dark",
  surface: "#1a1a19",
  surfaceSunken: "#262624",
  ink: "#ffffff",
  inkSecondary: "#c3c2b7",
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
  border: "rgba(255,255,255,0.10)",
  series: [
    "#3987e5",
    "#d95926",
    "#199e70",
    "#c98500",
    "#d55181",
    "#008300",
    "#9085e9",
    "#e66767",
  ],
  // On a dark surface "nothing" is dark, so the ramp runs the other way.
  sequential: [...BLUE].reverse(),
}

export const THEMES = [LIGHT, DARK]

/** At most eight series take a hue; a ninth is never generated. */
export const MAX_SERIES = 8

const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
export const WIDTH = 880
const PAD = 28

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** A rough width for 12px text, for laying out labels before the browser does. */
export function textWidth(text: string, size = 12): number {
  return text.length * size * 0.56
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, "")
}

function text(
  x: number,
  y: number,
  content: string,
  attrs: {
    size?: number
    fill: string
    weight?: number
    anchor?: "start" | "middle" | "end"
    extra?: string
  }
): string {
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${attrs.size ?? 12}"${attrs.weight ? ` font-weight="${attrs.weight}"` : ""} fill="${attrs.fill}"${attrs.anchor && attrs.anchor !== "start" ? ` text-anchor="${attrs.anchor}"` : ""}${attrs.extra ? ` ${attrs.extra}` : ""}>${esc(content)}</text>`
}

/**
 * A horizontal bar from `x0` to `x1`, square at the baseline and rounded 4px
 * at the data end.
 */
function hbar(
  x0: number,
  x1: number,
  y: number,
  h: number,
  fill: string,
  round = true
): string {
  const w = Math.max(0, x1 - x0)
  if (w === 0) return ""
  const r = round ? Math.min(4, w, h / 2) : 0
  return `<path d="M${fmt(x0)} ${fmt(y)}H${fmt(x0 + w - r)}${r ? `Q${fmt(x0 + w)} ${fmt(y)} ${fmt(x0 + w)} ${fmt(y + r)}` : ""}V${fmt(y + h - r)}${r ? `Q${fmt(x0 + w)} ${fmt(y + h)} ${fmt(x0 + w - r)} ${fmt(y + h)}` : ""}H${fmt(x0)}Z" fill="${fill}"/>`
}

export type Frame = {
  title: string
  subtitle: string
  /** One line under the plot: what the chart does not show, or where the data is. */
  note?: string
  height: number
  body: string
  /** For the <desc>, read by a screen reader. */
  description: string
}

/** Words into lines no wider than `width` at the given size. */
export function wrap(content: string, width: number, size: number): string[] {
  const out: string[] = []
  let line = ""
  for (const word of content.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && textWidth(next, size) > width) {
      out.push(line)
      line = word
    } else line = next
  }
  if (line) out.push(line)
  return out
}

export function frame(theme: Theme, f: Frame): string {
  const notes = f.note ? wrap(f.note, WIDTH - 2 * PAD, 11) : []
  const height = f.height + Math.max(0, notes.length - 1) * 15
  const noteY = f.height - 18
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="t d" font-family='${FONT}'>`,
    `<title id="t">${esc(f.title)}</title>`,
    `<desc id="d">${esc(f.description)}</desc>`,
    `<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="12" fill="${theme.surface}" stroke="${theme.border}"/>`,
    text(PAD, 38, f.title, { size: 17, weight: 600, fill: theme.ink }),
    text(PAD, 60, f.subtitle, { size: 12.5, fill: theme.inkSecondary }),
    f.body,
    ...notes.map((line, i) =>
      text(PAD, noteY + i * 15, line, { size: 11, fill: theme.muted })
    ),
    `</svg>`,
  ].join("\n")
}

/** Swatches in a row, left to right, wrapping at the chart's edge. */
function legend(
  theme: Theme,
  items: Array<{ label: string; color: string; shape?: "square" | "line" }>,
  y: number
): { svg: string; height: number } {
  let x = PAD
  let row = 0
  const parts: string[] = []
  for (const item of items) {
    const w = 18 + textWidth(item.label) + 18
    if (x + w > WIDTH - PAD) {
      x = PAD
      row++
    }
    const cy = y + row * 20
    parts.push(
      item.shape === "line"
        ? `<line x1="${x}" y1="${cy - 4}" x2="${x + 12}" y2="${cy - 4}" stroke="${item.color}" stroke-width="2" stroke-linecap="round"/><circle cx="${x + 6}" cy="${cy - 4}" r="3" fill="${item.color}"/>`
        : `<rect x="${x}" y="${cy - 10}" width="12" height="12" rx="3" fill="${item.color}"/>`,
      text(x + 18, cy, item.label, { fill: theme.inkSecondary })
    )
    x += w
  }
  return { svg: parts.join(""), height: (row + 1) * 20 }
}

function niceMax(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10])
    if (step * magnitude >= value) return step * magnitude
  return 10 * magnitude
}

function ticks(max: number, count = 5): number[] {
  const step = max / count
  return Array.from({ length: count + 1 }, (_, i) => i * step)
}

// --- horizontal bars on a log scale -----------------------------------------

export type LogBars = {
  title: string
  subtitle: string
  note?: string
  /** The series within each group, in slot order. */
  series: string[]
  rows: Array<{ label: string; values: Array<number | null> }>
  format: (value: number) => string
}

export function logBars(theme: Theme, chart: LogBars): string {
  const values = chart.rows
    .flatMap((r) => r.values)
    .filter((v): v is number => v !== null && v > 0)
  const lo = Math.floor(Math.log10(Math.min(...values)))
  let hi = Math.ceil(Math.log10(Math.max(...values)))
  if (hi === lo) hi = lo + 1
  const labelW = Math.min(
    230,
    Math.max(90, ...chart.rows.map((r) => textWidth(r.label) + 16))
  )
  const x0 = PAD + labelW
  const x1 = WIDTH - PAD - 70
  const x = (v: number) => x0 + ((Math.log10(v) - lo) / (hi - lo)) * (x1 - x0)
  const key = legend(
    theme,
    chart.series.map((label, i) => ({ label, color: theme.series[i] })),
    88
  )
  const bar = Math.min(14, Math.floor(60 / chart.series.length))
  const groupH = chart.series.length * (bar + 2) + 18
  const top = 88 + key.height + 10
  const plotH = chart.rows.length * groupH
  const parts: string[] = [key.svg]
  for (let d = lo; d <= hi; d++) {
    const gx = x(10 ** d)
    parts.push(
      `<line x1="${fmt(gx)}" y1="${top - 4}" x2="${fmt(gx)}" y2="${top + plotH}" stroke="${theme.grid}"/>`,
      text(gx, top + plotH + 16, chart.format(10 ** d), {
        size: 11,
        fill: theme.muted,
        anchor: "middle",
      })
    )
  }
  parts.push(
    `<line x1="${x0}" y1="${top - 4}" x2="${x0}" y2="${top + plotH}" stroke="${theme.axis}"/>`
  )
  chart.rows.forEach((row, r) => {
    const gy = top + r * groupH + 6
    parts.push(
      text(x0 - 10, gy + (chart.series.length * (bar + 2)) / 2 + 3, row.label, {
        fill: theme.ink,
        anchor: "end",
      })
    )
    row.values.forEach((value, s) => {
      const y = gy + s * (bar + 2)
      if (value === null || value <= 0) {
        parts.push(
          text(x0 + 6, y + bar - 3, "not measured", {
            size: 10.5,
            fill: theme.muted,
          })
        )
        return
      }
      parts.push(
        `<g><title>${esc(`${row.label}, ${chart.series[s]}: ${chart.format(value)}`)}</title>${hbar(x0, x(value), y, bar, theme.series[s])}</g>`,
        text(x(value) + 6, y + bar - 3, chart.format(value), {
          size: 10.5,
          fill: theme.inkSecondary,
        })
      )
    })
  })
  const height = top + plotH + 58
  return frame(theme, {
    title: chart.title,
    subtitle: chart.subtitle,
    note: chart.note,
    height,
    body: parts.join("\n"),
    description: `${chart.title}. ${chart.rows.map((r) => `${r.label}: ${r.values.map((v, i) => `${chart.series[i]} ${v === null ? "not measured" : chart.format(v)}`).join(", ")}`).join("; ")}.`,
  })
}

// --- a scatter with its frontier -------------------------------------------

export type Frontier = {
  title: string
  subtitle: string
  note?: string
  xLabel: string
  yLabel: string
  points: Array<{ label: string; x: number; y: number }>
  /** A level every point is read against: the patterns alone, at no cost. */
  baseline?: { label: string; y: number }
  formatX: (value: number) => string
  formatY: (value: number) => string
}

/** Points no other point beats on both cost and quality, cheapest first. */
export function paretoFrontier<T extends { x: number; y: number }>(
  points: T[]
): T[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || b.y - a.y)
  const out: T[] = []
  for (const point of sorted)
    if (out.length === 0 || point.y > out[out.length - 1].y) out.push(point)
  return out
}

export function frontier(theme: Theme, chart: Frontier): string {
  const xs = chart.points.map((p) => p.x)
  const ys = [
    ...chart.points.map((p) => p.y),
    ...(chart.baseline ? [chart.baseline.y] : []),
  ]
  let lo = Math.floor(Math.log10(Math.min(...xs)))
  let hi = Math.ceil(Math.log10(Math.max(...xs)))
  if (hi === lo) {
    lo -= 0.5
    hi += 0.5
  }
  const yLo = Math.max(0, Math.floor((Math.min(...ys) - 0.05) * 10) / 10)
  const yHi = Math.min(1, Math.ceil((Math.max(...ys) + 0.05) * 10) / 10)
  const key = legend(
    theme,
    [
      {
        label: "on the frontier: nothing cheaper does better",
        color: theme.series[0],
      },
      { label: "beaten on both cost and quality", color: theme.muted },
    ],
    88
  )
  const x0 = PAD + 48
  const x1 = WIDTH - PAD - 20
  const top = 88 + key.height + 34
  const plotH = 320
  const x = (v: number) => x0 + ((Math.log10(v) - lo) / (hi - lo)) * (x1 - x0)
  const y = (v: number) => top + plotH - ((v - yLo) / (yHi - yLo || 1)) * plotH
  const best = new Set(paretoFrontier(chart.points).map((p) => p.label))
  const parts: string[] = []
  for (let t = yLo; t <= yHi + 1e-9; t += 0.1) {
    parts.push(
      `<line x1="${x0}" y1="${fmt(y(t))}" x2="${x1}" y2="${fmt(y(t))}" stroke="${theme.grid}"/>`,
      text(x0 - 8, y(t) + 4, chart.formatY(t), {
        size: 11,
        fill: theme.muted,
        anchor: "end",
      })
    )
  }
  for (let d = Math.ceil(lo); d <= Math.floor(hi); d++) {
    parts.push(
      text(x(10 ** d), top + plotH + 18, chart.formatX(10 ** d), {
        size: 11,
        fill: theme.muted,
        anchor: "middle",
      })
    )
  }
  parts.push(
    `<line x1="${x0}" y1="${top + plotH}" x2="${x1}" y2="${top + plotH}" stroke="${theme.axis}"/>`,
    text((x0 + x1) / 2, top + plotH + 38, chart.xLabel, {
      size: 11.5,
      fill: theme.inkSecondary,
      anchor: "middle",
    }),
    text(PAD - 6, top - 14, chart.yLabel, {
      size: 11.5,
      fill: theme.inkSecondary,
    })
  )
  if (chart.baseline) {
    const by = y(chart.baseline.y)
    parts.push(
      `<line x1="${x0}" y1="${fmt(by)}" x2="${x1}" y2="${fmt(by)}" stroke="${theme.inkSecondary}" stroke-opacity="0.55"/>`,
      text(
        x1,
        by - 6,
        `${chart.baseline.label}: ${chart.yLabel} ${chart.formatY(chart.baseline.y)}`,
        { size: 11, fill: theme.inkSecondary, anchor: "end" }
      )
    )
  }
  const path = paretoFrontier(chart.points)
  if (path.length > 1)
    parts.push(
      `<polyline points="${path.map((p) => `${fmt(x(p.x))},${fmt(y(p.y))}`).join(" ")}" fill="none" stroke="${theme.series[0]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.45"/>`
    )
  const placed: Array<{ x: number; y: number }> = []
  for (const point of [...chart.points].sort((a, b) => a.x - b.x)) {
    const px = x(point.x)
    const py = y(point.y)
    const on = best.has(point.label)
    const color = on ? theme.series[0] : theme.muted
    const w = textWidth(point.label, 11.5)
    const right = px + 10 + w < x1
    let ly = py + 4
    while (
      placed.some((p) => Math.abs(p.y - ly) < 13 && Math.abs(p.x - px) < w + 20)
    )
      ly += 14
    placed.push({ x: px, y: ly })
    parts.push(
      `<g><title>${esc(`${point.label}: ${chart.formatX(point.x)} a document, ${chart.yLabel} ${chart.formatY(point.y)}`)}</title><circle cx="${fmt(px)}" cy="${fmt(py)}" r="12" fill="transparent"/><circle cx="${fmt(px)}" cy="${fmt(py)}" r="5" fill="${color}" stroke="${theme.surface}" stroke-width="2"/></g>`,
      text(right ? px + 10 : px - 10, ly, point.label, {
        size: 11.5,
        fill: on ? theme.ink : theme.inkSecondary,
        weight: on ? 600 : undefined,
        anchor: right ? "start" : "end",
      })
    )
  }
  return frame(theme, {
    title: chart.title,
    subtitle: chart.subtitle,
    note: chart.note,
    height: top + plotH + 84,
    body: [key.svg, ...parts].join("\n"),
    description: `${chart.title}. ${chart.points.map((p) => `${p.label}: ${chart.formatX(p.x)}, ${chart.formatY(p.y)}${best.has(p.label) ? " (frontier)" : ""}`).join("; ")}.`,
  })
}

// --- stacked horizontal bars, in panels -------------------------------------

export type Stacked = {
  title: string
  subtitle: string
  note?: string
  /** Segment names, in slot order. */
  series: string[]
  /** Slot per series, so a segment keeps its colour whichever are present. */
  slots?: number[]
  panels: Array<{
    title?: string
    rows: Array<{ label: string; segments: number[]; total?: string }>
  }>
  format: (value: number) => string
  /** Every bar on one scale; `share` draws each row as 100%. */
  scale?: "shared" | "share"
}

export function stacked(theme: Theme, chart: Stacked): string {
  const slots = chart.slots ?? chart.series.map((_, i) => i)
  const allRows = chart.panels.flatMap((p) => p.rows)
  // A series no bar has is left out of the legend; its colour stays its own.
  const key = legend(
    theme,
    chart.series
      .map((label, i) => ({ label, color: theme.series[slots[i]], i }))
      .filter(({ i }) => allRows.some((r) => r.segments[i] > 0)),
    88
  )
  const labelW = Math.min(
    230,
    Math.max(90, ...allRows.map((r) => textWidth(r.label) + 16))
  )
  const x0 = PAD + labelW
  const x1 = WIDTH - PAD - 90
  const max =
    chart.scale === "share"
      ? 1
      : niceMax(
          Math.max(...allRows.map((r) => r.segments.reduce((a, b) => a + b, 0)))
        )
  const bar = 18
  const rowH = bar + 10
  let y = 88 + key.height + 12
  const parts: string[] = [key.svg]
  for (const panel of chart.panels) {
    if (panel.title) {
      parts.push(
        text(PAD, y + 12, panel.title, {
          size: 12.5,
          weight: 600,
          fill: theme.ink,
        })
      )
      y += 22
    }
    const panelTop = y
    if (chart.scale !== "share")
      for (const t of ticks(max, 4)) {
        const gx = x0 + (t / max) * (x1 - x0)
        parts.push(
          `<line x1="${fmt(gx)}" y1="${panelTop - 2}" x2="${fmt(gx)}" y2="${panelTop + panel.rows.length * rowH - 6}" stroke="${theme.grid}"/>`
        )
      }
    for (const row of panel.rows) {
      const sum = row.segments.reduce((a, b) => a + b, 0)
      const scale = chart.scale === "share" ? (sum ? 1 / sum : 0) : 1 / max
      parts.push(
        text(x0 - 10, y + bar - 5, row.label, {
          fill: theme.ink,
          anchor: "end",
        })
      )
      let at = x0
      const last = row.segments.reduce((l, v, i) => (v > 0 ? i : l), -1)
      row.segments.forEach((value, s) => {
        if (value <= 0) return
        const w = value * scale * (x1 - x0)
        const end = at + w
        // A 2px gap in the surface colour between segments, never a border.
        const drawTo = s === last ? end : Math.max(at, end - 2)
        const share = sum ? value / sum : 0
        parts.push(
          `<g><title>${esc(`${row.label}, ${chart.series[s]}: ${chart.format(value)} (${(share * 100).toFixed(0)}%)`)}</title>${hbar(at, drawTo, y, bar, theme.series[slots[s]], s === last)}</g>`
        )
        const label =
          chart.scale === "share" ? `${(share * 100).toFixed(0)}%` : ""
        if (label && textWidth(label, 10.5) + 10 < drawTo - at) {
          parts.push(
            text((at + drawTo) / 2, y + bar - 5, label, {
              size: 10.5,
              fill: inkOn(theme.series[slots[s]]),
              anchor: "middle",
              weight: 600,
            })
          )
        }
        at = end
      })
      parts.push(
        text(
          chart.scale === "share" ? x1 + 8 : at + 8,
          y + bar - 5,
          row.total ?? chart.format(sum),
          { size: 10.5, fill: theme.inkSecondary }
        )
      )
      y += rowH
    }
    if (chart.scale !== "share")
      for (const t of ticks(max, 4)) {
        const gx = x0 + (t / max) * (x1 - x0)
        parts.push(
          text(gx, y + 8, chart.format(t), {
            size: 10.5,
            fill: theme.muted,
            anchor: "middle",
          })
        )
      }
    y += chart.scale === "share" ? 8 : 26
  }
  return frame(theme, {
    title: chart.title,
    subtitle: chart.subtitle,
    note: chart.note,
    height: y + 44,
    body: parts.join("\n"),
    description: `${chart.title}. ${chart.panels.map((p) => `${p.title ? `${p.title}: ` : ""}${p.rows.map((r) => `${r.label} ${r.segments.map((v, i) => `${chart.series[i]} ${chart.format(v)}`).join(", ")}`).join("; ")}`).join(". ")}.`,
  })
}

// --- lines over ordered categories ------------------------------------------

export type Lines = {
  title: string
  subtitle: string
  note?: string
  x: string[]
  xLabel: string
  yLabel: string
  series: Array<{
    label: string
    slot: number
    values: Array<number | null>
    flagged?: boolean[]
  }>
  format: (value: number) => string
  /** What a hollow marker means, when any is flagged. */
  flagLabel?: string
}

export function lines(theme: Theme, chart: Lines): string {
  const key = legend(
    theme,
    chart.series.map((s) => ({
      label: s.label,
      color: theme.series[s.slot],
      shape: "line" as const,
    })),
    88
  )
  const top = 88 + key.height + 20
  const plotH = 280
  const x0 = PAD + 52
  const x1 = WIDTH - PAD - 150
  const max = niceMax(
    Math.max(
      ...chart.series.flatMap((s) =>
        s.values.filter((v): v is number => v !== null)
      ),
      0
    )
  )
  const step = chart.x.length > 1 ? (x1 - x0) / (chart.x.length - 1) : 0
  const x = (i: number) => (chart.x.length > 1 ? x0 + i * step : (x0 + x1) / 2)
  const y = (v: number) => top + plotH - (v / max) * plotH
  const parts: string[] = [key.svg]
  const tickLabel = (t: number) =>
    max >= 5 ? String(Math.round(t)) : t.toFixed(1)
  for (const t of ticks(max)) {
    parts.push(
      `<line x1="${x0}" y1="${fmt(y(t))}" x2="${x1}" y2="${fmt(y(t))}" stroke="${t === 0 ? theme.axis : theme.grid}"/>`,
      text(x0 - 8, y(t) + 4, tickLabel(t), {
        size: 11,
        fill: theme.muted,
        anchor: "end",
      })
    )
  }
  chart.x.forEach((label, i) =>
    parts.push(
      text(x(i), top + plotH + 18, label, {
        size: 11,
        fill: theme.muted,
        anchor: "middle",
      })
    )
  )
  parts.push(
    text((x0 + x1) / 2, top + plotH + 38, chart.xLabel, {
      size: 11.5,
      fill: theme.inkSecondary,
      anchor: "middle",
    }),
    text(PAD - 6, top - 14, chart.yLabel, {
      size: 11.5,
      fill: theme.inkSecondary,
    })
  )
  // End labels only when they do not collide; the legend always carries identity.
  const ends = chart.series
    .map((s) => {
      const last = s.values.reduce<number>(
        (l, v, i) => (v === null ? l : i),
        -1
      )
      return last === -1 ? null : { s, i: last, y: y(s.values[last]!) }
    })
    .filter(
      (e): e is { s: Lines["series"][number]; i: number; y: number } =>
        e !== null
    )
    .sort((a, b) => a.y - b.y)
  const labelled = ends.every((e, k) => k === 0 || e.y - ends[k - 1].y >= 14)
  let anyFlag = false
  for (const s of chart.series) {
    const color = theme.series[s.slot]
    const points = s.values
      .map((v, i) => (v === null ? null : { i, v }))
      .filter((p): p is { i: number; v: number } => p !== null)
    if (points.length > 1)
      parts.push(
        `<polyline points="${points.map((p) => `${fmt(x(p.i))},${fmt(y(p.v))}`).join(" ")}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
      )
    for (const p of points) {
      const flagged = s.flagged?.[p.i] ?? false
      anyFlag ||= flagged
      parts.push(
        `<g><title>${esc(`${s.label}, ${chart.x[p.i]}: ${chart.format(p.v)}${flagged && chart.flagLabel ? ` (${chart.flagLabel})` : ""}`)}</title><circle cx="${fmt(x(p.i))}" cy="${fmt(y(p.v))}" r="12" fill="transparent"/><circle cx="${fmt(x(p.i))}" cy="${fmt(y(p.v))}" r="${flagged ? 4 : 4.5}" fill="${flagged ? theme.surface : color}" stroke="${flagged ? color : theme.surface}" stroke-width="2"/></g>`
      )
    }
  }
  if (labelled)
    for (const e of ends)
      parts.push(
        text(
          x(e.i) + 10,
          e.y + 4,
          `${e.s.label}  ${chart.format(e.s.values[e.i]!)}`,
          { size: 11.5, fill: theme.ink }
        )
      )
  return frame(theme, {
    title: chart.title,
    subtitle: chart.subtitle,
    note: [
      anyFlag && chart.flagLabel ? `Hollow marker: ${chart.flagLabel}.` : "",
      chart.note ?? "",
    ]
      .filter(Boolean)
      .join(" "),
    height: top + plotH + 84,
    body: parts.join("\n"),
    description: `${chart.title}. ${chart.series.map((s) => `${s.label}: ${s.values.map((v, i) => `${chart.x[i]} ${v === null ? "—" : chart.format(v)}`).join(", ")}`).join("; ")}.`,
  })
}

// --- heatmap ----------------------------------------------------------------

export type Heatmap = {
  title: string
  subtitle: string
  note?: string
  rows: string[]
  columns: string[]
  /** Column groups drawn as a bracket above the headers. */
  groups?: Array<{ label: string; from: number; to: number }>
  values: Array<Array<number | null>>
  format: (value: number) => string
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** White or near-black, whichever reads on this fill. */
export function inkOn(fill: string): string {
  return luminance(fill) > 0.32 ? "#0b0b0b" : "#ffffff"
}

export function sequentialColor(theme: Theme, value: number): string {
  const steps = theme.sequential
  const index = Math.round(Math.min(1, Math.max(0, value)) * (steps.length - 1))
  return steps[index]
}

export function heatmap(theme: Theme, chart: Heatmap): string {
  const labelW = Math.min(
    220,
    Math.max(100, ...chart.rows.map((r) => textWidth(r) + 16))
  )
  const x0 = PAD + labelW
  const cellW = Math.min(64, (WIDTH - PAD - x0) / chart.columns.length)
  const cellH = 30
  const headerH = 96
  const groupY = 84
  const top = groupY + (chart.groups ? 18 : 0) + headerH
  const parts: string[] = []
  for (const group of chart.groups ?? []) {
    const gx0 = x0 + group.from * cellW + 3
    const gx1 = x0 + (group.to + 1) * cellW - 3
    parts.push(
      `<line x1="${fmt(gx0)}" y1="${groupY + 8}" x2="${fmt(gx1)}" y2="${groupY + 8}" stroke="${theme.axis}" stroke-width="2" stroke-linecap="round"/>`,
      text((gx0 + gx1) / 2, groupY + 2, group.label, {
        size: 11.5,
        fill: theme.inkSecondary,
        anchor: "middle",
        weight: 600,
      })
    )
  }
  chart.columns.forEach((column, c) => {
    const cx = x0 + c * cellW + cellW / 2
    parts.push(
      text(cx, top - 10, column, {
        size: 11,
        fill: theme.inkSecondary,
        extra: `transform="rotate(-45 ${fmt(cx)} ${fmt(top - 10)})"`,
      })
    )
  })
  chart.rows.forEach((row, r) => {
    const y = top + r * cellH
    parts.push(
      text(x0 - 10, y + cellH / 2 + 4, row, { fill: theme.ink, anchor: "end" })
    )
    chart.columns.forEach((column, c) => {
      const value = chart.values[r]?.[c] ?? null
      const x = x0 + c * cellW
      const fill =
        value === null ? theme.surfaceSunken : sequentialColor(theme, value)
      parts.push(
        `<g><title>${esc(`${row}, ${column}: ${value === null ? "no labels" : chart.format(value)}`)}</title><rect x="${fmt(x + 1)}" y="${fmt(y + 1)}" width="${fmt(cellW - 2)}" height="${cellH - 2}" rx="4" fill="${fill}"/></g>`,
        text(
          x + cellW / 2,
          y + cellH / 2 + 4,
          value === null ? "—" : chart.format(value),
          {
            size: 10.5,
            fill: value === null ? theme.muted : inkOn(fill),
            anchor: "middle",
            weight: 600,
          }
        )
      )
    })
  })
  // The scale, so the colour can be read back to a number without the labels.
  const scaleY = top + chart.rows.length * cellH + 20
  const scaleW = 180
  const steps = theme.sequential
  steps.forEach((color, i) => {
    parts.push(
      `<rect x="${fmt(x0 + (i * scaleW) / steps.length)}" y="${scaleY}" width="${fmt(scaleW / steps.length + 0.5)}" height="8" fill="${color}"/>`
    )
  })
  parts.push(
    text(x0 - 6, scaleY + 8, chart.format(0), {
      size: 10.5,
      fill: theme.muted,
      anchor: "end",
    }),
    text(x0 + scaleW + 6, scaleY + 8, chart.format(1), {
      size: 10.5,
      fill: theme.muted,
    })
  )
  return frame(theme, {
    title: chart.title,
    subtitle: chart.subtitle,
    note: chart.note,
    height: scaleY + 56,
    body: parts.join("\n"),
    description: `${chart.title}. ${chart.rows.map((row, r) => `${row}: ${chart.columns.map((col, c) => `${col} ${chart.values[r]?.[c] === null ? "no labels" : chart.format(chart.values[r][c]!)}`).join(", ")}`).join("; ")}.`,
  })
}
