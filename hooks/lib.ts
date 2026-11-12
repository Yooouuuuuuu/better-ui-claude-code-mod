// Pure helpers: formatting, parsing tool inputs and outputs, skins, charts.
// Nothing here touches `$`.

import type { PromptDecoration } from 'claude-code'

import type { FileStat, Totals, TurnRec } from '../types'

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
export const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
export const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}

/** The last two path segments: `src/app.ts`. */
export const shortPath = (p: string): string =>
  p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

export const clip = (s: string, n: number): string =>
  s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s

export const fmtMs = (ms: number): string => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

export const fmtSeconds = (s: number): string =>
  s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`

export const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

export const fmtUsd = (usd: number | undefined): string => (usd === undefined ? '—' : `$${usd.toFixed(2)}`)

export const hhmm = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** `in 2h 10m` for an ISO timestamp in the future, `now` once passed. */
export const relTime = (iso: string, now: number): string => {
  const diff = Date.parse(iso) - now
  if (!Number.isFinite(diff) || diff <= 0) return 'now'
  const m = Math.round(diff / 60000)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `in ${h}h ${String(m % 60).padStart(2, '0')}m`
  return `in ${Math.round(h / 24)}d`
}

/** A text progress bar of `width` cells. */
export const bar = (pct: number, width: number): string => {
  const w = Math.max(1, width)
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * w)
  return '█'.repeat(filled) + '░'.repeat(w - filled)
}

/** A sparkline of block characters, one per value, scaled to the max. */
export const sparkline = (values: number[]): string => {
  const glyphs = '▁▂▃▄▅▆▇█'
  const max = Math.max(1, ...values)
  return values
    .map(v => glyphs[Math.min(7, Math.round((v / max) * 7))] ?? '▁')
    .join('')
}

// ---------------------------------------------------------------------------
// Tool inputs and outputs
// ---------------------------------------------------------------------------

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'WebFetch', 'WebSearch'])

/** Lines added and removed, read from an Edit/Write result's `structuredPatch`. */
export function countPatch(output: unknown): { adds: number; dels: number } | undefined {
  const out = rec(output)
  const patch = out.structuredPatch
  if (!Array.isArray(patch)) return undefined
  let adds = 0
  let dels = 0
  for (const hunk of patch) {
    const lines = rec(hunk).lines
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) adds += 1
      else if (line.startsWith('-')) dels += 1
    }
  }
  if (adds === 0 && dels === 0 && out.type === 'create' && typeof out.content === 'string') {
    adds = out.content.split('\n').length
  }
  return { adds, dels }
}

/** The result's `structuredPatch` as unified-diff hunks for a `Code` element; whole hunks up to a size. */
export function patchToDiff(output: unknown, maxChars = 6000): string | undefined {
  const hunks = rec(output).structuredPatch
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined
  const parts: string[] = []
  let size = 0
  for (const h of hunks) {
    const o = rec(h)
    const lines = Array.isArray(o.lines) ? o.lines.filter((l): l is string => typeof l === 'string') : []
    const header = `@@ -${num(o.oldStart)},${num(o.oldLines)} +${num(o.newStart)},${num(o.newLines)} @@`
    const chunk = [header, ...lines].join('\n')
    if (size + chunk.length > maxChars && parts.length > 0) break
    parts.push(chunk)
    size += chunk.length + 1
  }
  return parts.join('\n')
}

/** One short label for a tool call, from its input. */
export function labelOf(tool: string, input: unknown): string {
  const i = rec(input)
  switch (tool) {
    case 'Bash':
      return clip((str(i.command) ?? '').replace(/\s+/g, ' ').trim(), 60)
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'Read':
      return shortPath(str(i.file_path) ?? '')
    case 'NotebookEdit':
      return shortPath(str(i.notebook_path) ?? '')
    case 'Grep':
      return `/${clip(str(i.pattern) ?? '', 40)}/`
    case 'Glob':
      return clip(str(i.pattern) ?? '', 50)
    case 'Agent':
    case 'Task':
      return clip(str(i.description) ?? '', 50)
    case 'WebFetch':
      return clip(str(i.url) ?? '', 50)
    case 'WebSearch':
      return clip(str(i.query) ?? '', 50)
    case 'ToolSearch':
      return clip(str(i.query) ?? '', 50)
    default: {
      const first = Object.values(i).find(v => typeof v === 'string')
      return clip(typeof first === 'string' ? first : '', 50)
    }
  }
}

/** One dim line standing in for a tool's result block, or undefined to let the engine draw it. */
export function resultSummary(tool: string, output: unknown): string | undefined {
  const out = rec(output)
  switch (tool) {
    case 'Bash': {
      if (out.interrupted === true) return undefined
      const stdout = str(out.stdout) ?? ''
      const stderr = str(out.stderr) ?? ''
      const lines = stdout.split('\n').filter(l => l.trim() !== '')
      if (lines.length === 0) {
        return stderr.trim() === '' ? '(no output)' : clip(stderr.trim().split('\n')[0] ?? '', 80)
      }
      const last = (lines[lines.length - 1] ?? '').trim()
      return lines.length === 1 ? clip(last, 80) : `${lines.length} lines · ${clip(last, 60)}`
    }
    case 'Read': {
      const n = rec(out.file).numLines
      return typeof n === 'number' ? `${n} lines` : undefined
    }
    case 'Grep': {
      if (typeof out.numMatches === 'number') return `${out.numMatches} matches`
      return typeof out.numFiles === 'number' ? `${out.numFiles} files` : undefined
    }
    case 'Glob':
      return typeof out.numFiles === 'number' ? `${out.numFiles} files` : undefined
    default:
      return undefined
  }
}

/** Whether a Bash command ran tests, and what the output said. */
export function detectTests(
  command: string,
  stdout: string,
  stderr: string,
): { passed: number; failed: number } | undefined {
  if (!/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\b(vitest|jest|pytest|mocha|cargo\s+test|go\s+test|dotnet\s+test)\b/.test(command)) {
    return undefined
  }
  const text = `${stdout}\n${stderr}`
  const passed = /(\d+)\s+(passed|passing|ok)\b/i.exec(text)
  const failed = /(\d+)\s+(failed|failing)\b/i.exec(text)
  if (passed === null && failed === null) return undefined
  return { passed: Number(passed?.[1] ?? 0), failed: Number(failed?.[1] ?? 0) }
}

/** A one-line warning for a risky shell command, or undefined. */
export function riskOf(command: string): string | undefined {
  const c = command.trim()
  if (/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i.test(c) || /\bRemove-Item\b.*-Recurse/i.test(c)) {
    return 'Deletes files recursively'
  }
  if (/\bgit\s+push\b.*(--force|-f\b)/.test(c)) return 'Force-pushes: rewrites remote history'
  if (/\bgit\s+push\b/.test(c)) return 'Pushes to the remote'
  if (/\bgit\s+reset\s+--hard\b/.test(c)) return 'Discards uncommitted changes'
  if (/\bgit\s+clean\b/.test(c)) return 'Deletes untracked files'
  if (/\bgit\s+checkout\s+(--\s+)?\./.test(c)) return 'Reverts working-tree changes'
  if (/\b(drop\s+(table|database)|truncate\s+table)\b/i.test(c)) return 'Destroys database data'
  if (/\b(npm|pnpm|yarn)\s+publish\b/.test(c)) return 'Publishes a package'
  if (/\bdocker\s+(system\s+prune|rm|rmi)\b/.test(c)) return 'Removes Docker resources'
  return undefined
}

// ---------------------------------------------------------------------------
// Ratings, streaks, achievements
// ---------------------------------------------------------------------------

export type Rating = 'fast' | 'good' | 'slow' | 'bad'

export function rateTurn(seconds: number, errors: number, reason: string): Rating {
  if (reason === 'error' || errors > 0) return 'bad'
  if (seconds < 15) return 'fast'
  if (seconds > 120) return 'slow'
  return 'good'
}

export function achievements(t: Totals, turns: TurnRec[], files: Record<string, FileStat>): string[] {
  const out: string[] = []
  const reads = (t.byTool.Read ?? 0) + (t.byTool.Grep ?? 0) + (t.byTool.Glob ?? 0)
  if (t.calls >= 1) out.push('First call')
  if (t.calls >= 100) out.push('Centurion · 100 tool calls')
  if (t.calls >= 500) out.push('Machine · 500 tool calls')
  if (Object.keys(files).length >= 5) out.push('Editor · 5 files touched')
  if (t.biggestEdit >= 100) out.push('Big refactor · 100+ line edit')
  if (t.testsPassed >= 1) out.push('Green · tests passed')
  if (t.testsFailed >= 1 && t.testsPassed >= 1) out.push('Comeback · failed then passed')
  if (t.bestStreak >= 5) out.push('Streak 5 · clean turns')
  if (t.bestStreak >= 10) out.push('Streak 10 · clean turns')
  if (turns.some(x => x.seconds >= 300)) out.push('Marathon · a 5-minute turn')
  if (reads >= 50) out.push('Explorer · 50 reads and searches')
  if (turns.length >= 25) out.push('Long session · 25 turns')
  return out
}

// ---------------------------------------------------------------------------
// Skins: icon sets
// ---------------------------------------------------------------------------

export type Skin = {
  spin: string[]
  ok: string
  err: string
  run: string
  int: string
  rating: Record<Rating, string>
  tool: Record<string, string>
  user: string
}

/** Set A, line glyphs: thin single-width symbols that common coding fonts carry. */
const TOOL_ICONS: Record<string, string> = {
  Bash: '›',
  PowerShell: '›',
  Monitor: '›',
  Read: '≡',
  NotebookRead: '≡',
  Edit: '±',
  Write: '±',
  MultiEdit: '±',
  NotebookEdit: '±',
  Grep: '◎',
  Glob: '◎',
  ToolSearch: '◎',
  LSP: '◎',
  Agent: '◆',
  Task: '◆',
  Workflow: '◆',
  SendMessage: '◆',
  WebFetch: '↓',
  WebSearch: '↓',
  TodoWrite: '≡',
}

/** What kind of work a tool does: each kind has its own colour. */
export type ToolKind = 'shell' | 'read' | 'edit' | 'search' | 'agent' | 'web' | 'other'

export function toolKind(tool: string): ToolKind {
  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'Monitor') return 'shell'
  if (tool === 'Read' || tool === 'NotebookRead') return 'read'
  if (EDIT_TOOLS.has(tool) || tool === 'NotebookEdit') return 'edit'
  if (tool === 'Grep' || tool === 'Glob' || tool === 'ToolSearch' || tool === 'LSP') return 'search'
  if (tool === 'Agent' || tool === 'Task' || tool === 'Workflow' || tool === 'SendMessage') return 'agent'
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  return 'other'
}

/** The theme colour for a tool kind. The themes set these subagent colours too. */
export const KIND_COLOR: Record<ToolKind, string> = {
  shell: 'green_FOR_SUBAGENTS_ONLY',
  read: 'cyan_FOR_SUBAGENTS_ONLY',
  edit: 'pink_FOR_SUBAGENTS_ONLY',
  search: 'yellow_FOR_SUBAGENTS_ONLY',
  agent: 'purple_FOR_SUBAGENTS_ONLY',
  web: 'orange_FOR_SUBAGENTS_ONLY',
  other: 'text',
}


export const SKINS: Record<string, Skin> = {
  line: {
    spin: ['·', '∙', '•', '●', '•', '∙'],
    ok: '✓',
    err: '×',
    run: '○',
    int: '■',
    rating: { fast: '»', good: '✓', slow: '…', bad: '×' },
    tool: TOOL_ICONS,
    user: '▌',
  },
}

export const skinOf = (name: string): Skin => SKINS[name] ?? SKINS.line!

export const toolIcon = (skin: Skin, tool: string): string => skin.tool[tool] ?? '·'

// ---------------------------------------------------------------------------
// Prompt tips and prompt-box coloring
// ---------------------------------------------------------------------------

export const TIPS: string[] = [
  'ctrl+x tab focuses the panel, 1–7 switch its tabs',
  'ctrl+o shows the full transcript behind the compact rows',
  '/better-ui reopens the panel',
  'Esc returns from the panel to the prompt',
  'Tab walks the panel buttons, Enter presses one',
  '/tui fullscreen docks the panel as a sidebar',
  'Settings tab: skins, compact rows, alarm',
  'History tab: click a turn to jump to its prompt',
]

/** Color runs over the draft: `@file` references, a leading `/command`, and `code` spans. */
export function decoratePrompt(text: string): PromptDecoration[] {
  const out: PromptDecoration[] = []
  const at = /(^|\s)(@[^\s@]+)/g
  for (let m = at.exec(text); m !== null; m = at.exec(text)) {
    const start = m.index + (m[1]?.length ?? 0)
    out.push({ start, end: start + (m[2]?.length ?? 0), color: 'success' })
  }
  const cmd = /^\/[a-zA-Z][\w:-]*/.exec(text)
  if (cmd !== null) out.push({ start: 0, end: cmd[0].length, color: 'planMode', bold: true })
  const code = /`[^`\n]+`/g
  for (let m = code.exec(text); m !== null; m = code.exec(text)) {
    out.push({ start: m.index, end: m.index + m[0].length, color: 'warning' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Raster packing (a grid of colored cells)
// ---------------------------------------------------------------------------

const DEFAULT_COLOR = 0x01000000

/** Packs rows of [character, 0xRRGGBB] into the base64 a `Raster` takes. */
export function packCells(rows: [string, number][][]): string {
  const cells = rows.flat()
  const bytes = new Uint8Array(cells.length * 12)
  const view = new DataView(bytes.buffer)
  cells.forEach(([ch, color], i) => {
    view.setUint32(i * 12, ch.codePointAt(0) ?? 0x20, true)
    view.setUint32(i * 12 + 4, color, true)
    view.setUint32(i * 12 + 8, DEFAULT_COLOR, true)
  })
  return base64(bytes)
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1]
    const c = bytes[i + 2]
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0)
    out += B64[(n >> 18) & 63]
    out += B64[(n >> 12) & 63]
    out += b === undefined ? '=' : B64[(n >> 6) & 63]
    out += c === undefined ? '=' : B64[n & 63]
  }
  return out
}

/** Green → yellow → red by how often a file was edited. */
export function heatColor(edits: number, max: number): number {
  const t = Math.min(1, edits / Math.max(1, max))
  const r = Math.round(t < 0.5 ? 0x2e + (0xf9 - 0x2e) * (t * 2) : 0xf9 + (0xc6 - 0xf9) * ((t - 0.5) * 2))
  const g = Math.round(t < 0.5 ? 0x7d + (0xa8 - 0x7d) * (t * 2) : 0xa8 + (0x28 - 0xa8) * ((t - 0.5) * 2))
  const b = Math.round(t < 0.5 ? 0x32 + (0x25 - 0x32) * (t * 2) : 0x25 + (0x28 - 0x25) * ((t - 0.5) * 2))
  return (r << 16) | (g << 8) | b
}

/** A short label for a rate-limit window: known kinds get their usual name, others are prettified. */
export function limitName(kind: string): string {
  const known: Record<string, string> = {
    five_hour: '5h',
    seven_day: '7d',
    spend_limit: 'spend',
  }
  if (known[kind] !== undefined) return known[kind]
  return kind
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => (part === 'five' ? '5' : part === 'seven' ? '7' : part === 'hour' ? 'h' : part === 'day' ? 'd' : part))
    .join(' ')
    .replace(/\b5 h\b/g, '5h')
    .replace(/\b7 d\b/g, '7d')
}

/** The fields of an object this mod does not know, as `[key, short value]` pairs, so new figures still show. */
export function extraFields(obj: unknown, known: readonly string[]): [string, string][] {
  if (obj === null || typeof obj !== 'object') return []
  const out: [string, string][] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (known.includes(k) || v === undefined) continue
    let text: string
    if (typeof v === 'string') text = v
    else if (typeof v === 'number' || typeof v === 'boolean') text = String(v)
    else {
      try {
        text = JSON.stringify(v)
      } catch {
        text = String(v)
      }
    }
    out.push([k, clip(text, 60)])
  }
  return out
}

// ---- bindings the mod installs into ~/.claude/keybindings.json ----

export const HOTKEY = 'alt+s'
export const HOTKEY_ACTION = 'abovePrompt:focus'
/** One line of keybindings.json: `value` null unbinds an engine default. */
export type BindingEntry = { context: string; key: string; value: string | null }
/** The focus shortcut. */
export const FOCUS_BINDINGS: readonly BindingEntry[] = [{ context: 'Chat', key: HOTKEY, value: HOTKEY_ACTION }]
/** Unbinds the pane resize chords, so ctrl+x with an arrow no longer changes the pane's size. */
export const LOCK_BINDINGS: readonly BindingEntry[] = [
  { context: 'Pane', key: 'ctrl+x left', value: null },
  { context: 'Pane', key: 'ctrl+x right', value: null },
  { context: 'Pane', key: 'ctrl+x up', value: null },
  { context: 'Pane', key: 'ctrl+x down', value: null },
]
export type BindingOutcome = 'installed' | 'present' | 'removed' | 'absent' | 'occupied' | 'unparsable'
type BindingBlock = { context?: unknown; bindings?: unknown }

/**
 * Merges a set of bindings into (or out of) a keybindings.json text. Everything
 * else in the file is kept; a file that does not parse is left alone. Installing
 * refuses when a key is already bound to something else; removing takes out only
 * lines that hold exactly what the mod wrote.
 */
export function mergeBindings(
  text: string | null,
  entries: readonly BindingEntry[],
  want: boolean,
): { text?: string; outcome: BindingOutcome } {
  let doc: Record<string, unknown>
  if (text === null || text.trim() === '') {
    doc = {
      $schema: 'https://www.schemastore.org/claude-code-keybindings.json',
      $docs: 'https://code.claude.com/docs/en/keybindings',
      bindings: [],
    }
  } else {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { outcome: 'unparsable' }
      doc = parsed as Record<string, unknown>
    } catch {
      return { outcome: 'unparsable' }
    }
  }
  if (doc.bindings === undefined) doc.bindings = []
  if (!Array.isArray(doc.bindings)) return { outcome: 'unparsable' }
  const blocks = doc.bindings as unknown[]
  const isBlock = (b: unknown): b is BindingBlock & { bindings: Record<string, unknown> } =>
    b !== null &&
    typeof b === 'object' &&
    (b as BindingBlock).bindings !== null &&
    typeof (b as BindingBlock).bindings === 'object'
  const blockFor = (context: string) => blocks.filter(isBlock).find(b => b.context === context)

  if (want) {
    for (const e of entries) {
      const b = blockFor(e.context)
      if (b !== undefined && e.key in b.bindings && b.bindings[e.key] !== e.value) return { outcome: 'occupied' }
    }
    let changed = false
    for (const e of entries) {
      let b = blockFor(e.context)
      if (b === undefined) {
        b = { context: e.context, bindings: {} }
        blocks.push(b)
      }
      if (!(e.key in b.bindings)) {
        b.bindings[e.key] = e.value
        changed = true
      }
    }
    return changed ? { text: JSON.stringify(doc, null, 2) + '\n', outcome: 'installed' } : { outcome: 'present' }
  }

  let changed = false
  for (const e of entries) {
    const b = blockFor(e.context)
    if (b === undefined || !(e.key in b.bindings) || b.bindings[e.key] !== e.value) continue
    delete b.bindings[e.key]
    changed = true
    if (Object.keys(b.bindings).length === 0) blocks.splice(blocks.indexOf(b), 1)
  }
  return changed ? { text: JSON.stringify(doc, null, 2) + '\n', outcome: 'removed' } : { outcome: 'absent' }
}

/** A result that fits a tool row's narrow result column: a count, never output text. */
export function shortResult(tool: string, output: unknown): string {
  const out = rec(output)
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (out.interrupted === true) return 'stopped'
    const n = (str(out.stdout) ?? '').split('\n').filter(l => l.trim() !== '').length
    return n === 0 ? 'no output' : n === 1 ? '1 line' : `${n} lines`
  }
  return resultSummary(tool, output) ?? ''
}
