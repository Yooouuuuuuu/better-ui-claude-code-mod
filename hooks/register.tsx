import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, Timer } from 'claude-code'

import type { Activity, EditRec, Notice, Prefs, Running, Totals, TurnRec } from '../types'
import {
  EDIT_TOOLS,
  ARROW_BINDINGS,
  FOCUS_BINDINGS,
  KIND_COLOR,
  HOTKEY,
  OLD_BINDINGS,
  SKINS,
  clip,
  countPatch,
  decoratePrompt,
  detectTests,
  extraFields,
  limitName,
  fmtMs,
  fmtSeconds,
  fmtTokens,
  hhmm,
  labelOf,
  mergeBindings,
  toolKind,
  shortResult,
  patchToDiff,
  rateTurn,
  rec,
  relTime,
  resultSummary,
  riskOf,
  shortPath,
  skinOf,
  str,
  toolIcon,
} from './lib'
import { AVATAR_H, AVATAR_W, BUBBLE_W, avatarCells, avatarKey, clearAvatarCells } from './avatar'
import type { AvatarEvents, AvatarState } from './avatar'

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const PANE = 'better-ui'
const TITLE = 'Better UI'
const LONG_TURN_SECONDS = 120
const BIG_EDIT_LINES = 100
// The user message block draws with the theme's names, so themes/*.json
// sets its colours. userMessageBackground is a theme token the mod API does
// not list; the terminal resolves it from the theme all the same.
const USER_TINT = 'userMessageBackground'
const USER_ACCENT = 'briefLabelYou'
const USER_RULE = 'subtle'
const TABS = ['Overview', 'Usage', 'History', 'Agents', 'Control'] as const
type Tab = (typeof TABS)[number]

const DEFAULT_PREFS: Prefs = {
  compactRows: true,
  alarm: true,
  hideNotices: true,
  showOwnNotices: true,
  paint: true,
  skin: 'line',
  hotkey: true,
  lockArrows: true,
  leftArrowOff: true,
  companion: false,
}
const EMPTY_TOTALS: Totals = {
  calls: 0,
  errors: 0,
  byTool: {},
  streak: 0,
  bestStreak: 0,
  testsPassed: 0,
  testsFailed: 0,
  biggestEdit: 0,
}

// ---------------------------------------------------------------------------
// State (survives a hot reload; prefs also go to $.store)
// ---------------------------------------------------------------------------

/**
 * A new file's preview: whole lines up to about 4,000 characters, the hunk
 * header counting exactly the lines kept, so it stays a valid unified diff.
 */
function newFileDiff(lines: string[], maxChars = 4000): string {
  const kept: string[] = []
  let size = 0
  for (const line of lines) {
    if (size + line.length + 2 > maxChars && kept.length > 0) break
    kept.push('+' + line)
    size += line.length + 2
  }
  return [`@@ -0,0 +1,${kept.length} @@`, ...kept].join('\n')
}

/** Edits kept for History's changed files, each with its preview, for this session only. */
const EDITS_KEPT = 150
const TURNS_SHOWN = 5
const edits = atom({ plugin: 'better-ui', key: 'edits' } as const, [] as EditRec[], { shape: 'edits-1' })
const activity = atom({ plugin: 'better-ui', key: 'activity' } as const, [] as Activity[], {
  shape: 'activity-2',
})
const turns = atom({ plugin: 'better-ui', key: 'turns' } as const, [] as TurnRec[], { shape: 'turns-1' })
const totals = atom({ plugin: 'better-ui', key: 'totals' } as const, EMPTY_TOTALS, { shape: 'totals-2' })
const notices = atom({ plugin: 'better-ui', key: 'notices' } as const, [] as Notice[], {
  shape: 'notices-1',
})
const prompts = atom({ plugin: 'better-ui', key: 'prompts' } as const, {} as Record<string, number>, {
  shape: 'prompts-1',
})
const prefs = atom({ plugin: 'better-ui', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-1' })
const running = atom({ plugin: 'better-ui', key: 'running' } as const, null as Running | null)
const tick = atom({ plugin: 'better-ui', key: 'tick' } as const, 0)
const tab = atom({ plugin: 'better-ui', key: 'tab' } as const, 'Overview')
const pickedTurn = atom({ plugin: 'better-ui', key: 'pickedTurn' } as const, null as number | null)
const expandedFile = atom({ plugin: 'better-ui', key: 'expandedFile' } as const, null as string | null)
const hidden = atom({ plugin: 'better-ui', key: 'hidden' } as const, false)
const mini = atom({ plugin: 'better-ui', key: 'mini' } as const, false)
const folds = atom({ plugin: 'better-ui', key: 'folds' } as const, {} as Record<string, boolean>)
const pins = atom({ plugin: 'better-ui', key: 'pins' } as const, [] as string[])
const recent = atom({ plugin: 'better-ui', key: 'recent' } as const, [] as string[])
const cmdFilter = atom({ plugin: 'better-ui', key: 'cmdFilter' } as const, '')
const pinEdit = atom({ plugin: 'better-ui', key: 'pinEdit' } as const, false)
const colorDraft = atom({ plugin: 'better-ui', key: 'colorDraft' } as const, {
  preset: 'dark',
  colors: {} as Record<string, string>,
})
const colorEdit = atom({ plugin: 'better-ui', key: 'colorEdit' } as const, null as string | null)

/**
 * Whether Remote Control is connected, read from Claude Code itself: its
 * /remote-control command describes itself as "Disconnect Remote Control"
 * while connected. null when the command is not there (logged out, disabled).
 */
let rcCache: { at: number; value: boolean | null } = { at: -Infinity, value: null }
/** rcLive, reused for 3 s: the hint line redraws on every keystroke. */
async function rcCached($: CoreEngineInterface): Promise<boolean | null> {
  const now = await $.clock.now()
  if (now - rcCache.at < 3000) return rcCache.value
  rcCache = { at: now, value: await rcLive($) }
  return rcCache.value
}

async function rcLive($: CoreEngineInterface): Promise<boolean | null> {
  try {
    const cmd = (await $.command.list()).find(c => c.name === 'remote-control')
    return cmd === undefined ? null : /disconnect/i.test(cmd.description)
  } catch {
    return null
  }
}

async function minimize($: CoreEngineInterface): Promise<void> {
  await update($, mini, () => true)
  await update($, hidden, () => false)
  await $.ui.close({ id: PANE })
}

/** Reopens the pane, taking the keyboard, and drops the band. */
async function expand($: CoreEngineInterface): Promise<string> {
  await update($, mini, () => false)
  await update($, hidden, () => false)
  const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  return opened.isPlaced
    ? 'Better UI shown. 1–5 or a/d switch tabs, m minimizes, Esc returns to the prompt.'
    : `Better UI is waiting for room: ${opened.reason}`
}

// ---------------------------------------------------------------------------
// Helpers that use $
// ---------------------------------------------------------------------------

const NOTICES_KEPT = 80

/** A toast from Better UI, also kept among the notices, marked as the mod's own. */
function say($: CoreEngineInterface, text: string): void {
  $.ui.toast(text)
  void (async () => {
    const at = await $.clock.now()
    await update($, notices, list => [...list, { text, command: null, at, source: 'ui' as const }].slice(-NOTICES_KEPT))
  })()
}

async function notify($: CoreEngineInterface, text: string): Promise<void> {
  try {
    const sent = await $.ui.notify(text, { title: TITLE })
    if (!sent.isSent) say($, text)
  } catch {
    say($, text)
  }
}

async function savePrefs($: CoreEngineInterface, change: (p: Prefs) => Prefs): Promise<void> {
  const next = change(await read($, prefs))
  await update($, prefs, () => next)
  await $.store.set('prefs', next)
}

/** Where the engine reads the person's keybindings: CLAUDE_CONFIG_DIR, else ~/.claude. */
async function keybindingsPath($: CoreEngineInterface): Promise<string> {
  const configDir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (configDir !== undefined && configDir !== '') return `${configDir}/keybindings.json`
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (home === undefined || home === '') throw new Error('no HOME or USERPROFILE')
  return `${home}/.claude/keybindings.json`
}

/**
 * Installs or removes one set of bindings in keybindings.json. The engine watches
 * that file, so the change applies at once. `loud` reports every outcome.
 */
// ---------------------------------------------------------------------------
// The avatar: a pixel figure in Overview's free space (drawn by avatar.ts)
// ---------------------------------------------------------------------------

const COMPANION_KEY = 'companion'
const COMPANION_MS = 100
/** A tool's loop stays this many steps after the call ends, so quick calls do not flicker. */
const AVATAR_HOLD_STEPS = 16

/** Which loop a tool call shows while it runs; any other tool leaves the figure thinking. */
function avatarToolState(tool: string): AvatarState | undefined {
  if (EDIT_TOOLS.has(tool)) return 'writing'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob' || tool === 'Bash' || tool === 'PowerShell') return 'computer'
  return undefined
}

/**
 * Claude Code's "← opens agents" setting. With it on, ← at an empty prompt
 * moves the session into the background and opens agent view; the panel then
 * runs in an attached background session, where mouse clicks do not arrive.
 * `want`: the value the setting should hold. Quiet unless it changes it or `loud`.
 */
async function syncLeftArrow($: CoreEngineInterface, want: boolean, loud: boolean): Promise<void> {
  try {
    const row = (await $.config.list()).find(
      r => r.key === 'leftArrowOpensAgents' || /opens agents/i.test(r.label),
    )
    if (row === undefined) {
      if (loud) say($, '← opens agents: this Claude Code has no such setting')
      return
    }
    if (row.value === want) return
    if (row.isLocked) {
      say($, '← opens agents is set by your organization; Better UI left it alone')
      return
    }
    const r = await $.config.set({ key: row.key, value: want })
    if (r.deny !== undefined) say($, `← opens agents not changed: ${r.deny}`)
    else if (want) say($, '← at an empty prompt opens agent view again')
    else say($, 'Turned off "← opens agents": it moved the session to the background, where the panel loses the mouse. Control → preferences turns it back on.')
  } catch (err) {
    if (loud) say($, `← opens agents: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Claude Code's version, as `claude --version` prints it; read once. */
let engineVersionText: string | undefined
async function engineVersion($: CoreEngineInterface): Promise<string> {
  if (engineVersionText === undefined) {
    try {
      engineVersionText = (await $.session.version()).version
    } catch {
      return '—'
    }
  }
  return engineVersionText
}

/** The keys of a drawn tree's controls in the order the focus ring walks them; what is not drawn is left out. */
function controlKeys(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) controlKeys(child, out)
    return out
  }
  if (node === null || typeof node !== 'object') return out
  const el = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown }
  const props = el.props ?? {}
  if (props.display === 'none') return out
  if ((el.type === 'Button' || el.type === 'Input' || el.type === 'Select') && typeof props.key === 'string') {
    out.push(props.key)
    return out
  }
  controlKeys(props.children, out)
  controlKeys(el.children, out)
  return out
}

async function syncBindings(
  $: CoreEngineInterface,
  which: 'focus' | 'arrows',
  want: boolean,
  loud: boolean,
): Promise<void> {
  const entries = which === 'focus' ? FOCUS_BINDINGS : ARROW_BINDINGS
  const name = which === 'focus' ? `${HOTKEY} shortcut` : 'arrow keys inside the panel'
  try {
    const path = await keybindingsPath($)
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : null
    const before = typeof existing === 'string' ? existing : null
    // An earlier version's arrow lines go first, so the new ones are not refused as taken.
    const cleaned = which === 'arrows' ? mergeBindings(before, OLD_BINDINGS, false).text : undefined
    const r = mergeBindings(cleaned ?? before, entries, want)
    const text = r.text ?? (r.outcome === 'unparsable' ? undefined : cleaned)
    if (text !== undefined) await $.fs.write(path, text)
    switch (r.outcome) {
      case 'installed':
        say($, `${name} installed (keybindings.json)`)
        break
      case 'removed':
        say($, `${name} removed (keybindings.json)`)
        break
      case 'occupied':
        say($, `${name}: a key is already bound to something else; not installed`)
        break
      case 'unparsable':
        if (loud || want) say($, `keybindings.json could not be parsed; ${name} left alone`)
        break
      default:
        if (loud) say($, want ? `${name} already installed` : `${name} was not installed`)
    }
  } catch (err) {
    if (loud) say($, `${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Subagents still running, pending or waiting; 0 when the list cannot be read. */
async function liveAgentCount($: CoreEngineInterface): Promise<number> {
  try {
    const agents = await $.agent.list()
    return agents.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting').length
  } catch {
    return 0
  }
}

/** The context window's fill as a percentage, or null when the engine has no reading. */
async function contextPercent($: CoreEngineInterface): Promise<number | null> {
  try {
    const usage = await $.session.usage()
    return usage.context.percent ?? null
  } catch {
    return null
  }
}

/**
 * Copies the mod's themes into ~/.claude/themes, which /theme lists; a mods
 * folder's own themes/ is not read. Writes only what differs.
 */
async function installThemes($: CoreEngineInterface): Promise<void> {
  try {
    const kb = await keybindingsPath($)
    const dir = kb.slice(0, kb.length - 'keybindings.json'.length) + 'themes'
    const hadDir = await $.fs.exists(dir)
    let wrote = 0
    for (const name of ['better-ui.json']) {
      const text = await $.fs.read(`${$.plugin.root}/themes/${name}`)
      if (typeof text !== 'string') continue
      const target = `${dir}/${name}`
      const old = (await $.fs.exists(target)) ? await $.fs.read(target) : null
      if (old === text) continue
      await $.fs.write(target, text)
      wrote += 1
    }
    if (wrote > 0) {
      say($, 
        hadDir
          ? 'Better UI themes installed: pick one in /theme'
          : 'Better UI themes installed: restart Claude Code once, then pick one in /theme',
      )
    }
  } catch (err) {
    say($, `Better UI themes not installed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The dim rounded frame around tool rows, indented under Claude's text. */
function toolFrame(Box: any, children: unknown) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="inactive"
      borderDimColor
      paddingX={1}
      marginLeft={2}
      marginTop={1}
    >
      {children}
    </Box>
  )
}

/** One call as its row needs it, from a ToolUse row or one call of a folded group. */
type CallView = {
  id?: string
  tool: string
  input: unknown
  output?: unknown
  isRunning: boolean
  isErrored: boolean
  isInterrupted: boolean
}

/**
 * Draws one call in fixed columns: status, icon, tool, target, result,
 * duration. A running call reads the ticker, so its timer counts up.
 */
async function callRow(
  $: CoreEngineInterface,
  ui: { Box: any; Text: any },
  p: Prefs,
  acts: Activity[],
  c: CallView,
) {
  const { Box, Text } = ui
  const skin = skinOf(p.skin)
  const act = c.id === undefined ? undefined : acts.find(a => a.id === c.id)
  const status = c.isInterrupted ? 'int' : c.isRunning ? 'run' : c.isErrored ? 'err' : 'ok'
  // A finished call needs no mark: only failed, running and stopped ones get one.
  const icon = { run: skin.run, ok: ' ', err: skin.err, int: skin.int }[status]
  const color = { run: 'warning', ok: 'success', err: 'error', int: 'warning' }[status]
  const kindColor = KIND_COLOR[toolKind(c.tool)]
  const patch = EDIT_TOOLS.has(c.tool) ? countPatch(c.output) : undefined
  const tickNow = c.isRunning && act !== undefined ? (await read($, tick), await $.clock.now()) : 0
  const ms = c.isRunning && act !== undefined ? tickNow - act.at : act?.ms
  const result =
    status === 'run' ? 'running'
    : status === 'int' ? 'stopped'
    : patch !== undefined ? undefined
    : status === 'err' ? 'failed'
    : shortResult(c.tool, c.output)
  return (
    <Box key={`call:${c.id ?? c.tool}`} flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={color}>{icon}</Text>
      </Box>
      <Box width={2} flexShrink={0}>
        <Text color={kindColor ?? 'inactive'}>{toolIcon(skin, c.tool)}</Text>
      </Box>
      <Box width={8} flexShrink={0}>
        <Text color={kindColor} bold={kindColor !== undefined} wrap="truncate-end">
          {c.tool}
        </Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} minWidth={8}>
        <Text wrap="truncate-end">{labelOf(c.tool, c.input)}</Text>
      </Box>
      <Box width={13} flexShrink={0} paddingLeft={1}>
        {patch !== undefined ? (
          <Text>
            <Text color="success">+{patch.adds}</Text> <Text color="error">−{patch.dels}</Text>
          </Text>
        ) : (
          <Text color={status === 'err' ? 'error' : status === 'run' || status === 'int' ? 'warning' : 'inactive'} wrap="truncate-end">
            {result}
          </Text>
        )}
      </Box>
      <Box width={7} flexShrink={0} justifyContent="flex-end">
        <Text color={status === 'run' ? 'warning' : 'inactive'}>{ms !== undefined ? fmtMs(ms) : ''}</Text>
      </Box>
    </Box>
  )
}

/** Paths with uncommitted changes, relative to the repo root; null outside a repo. */
// ---------------------------------------------------------------------------
// The mod
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Control tab: commands, pins, recent, colors
// ---------------------------------------------------------------------------

const DEFAULT_PINS = ['remote-control', 'compact', 'fork', 'rewind', 'resume', 'add-dir']
const RECENT_MAX = 5
const DEFAULT_FOLDS: Record<string, boolean> = {
  pinned: true,
  recent: true,
  all: false,
  'all:skills': false,
  'all:mcp': false,
  colors: false,
  prefs: false,
}

/** Built-in commands sorted into the panel's groups; any other built-in lands in "other". */
const COMMAND_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ['session', ['compact', 'clear', 'resume', 'rewind', 'fork', 'export', 'rename', 'exit']],
  ['model & context', ['model', 'context', 'usage', 'cost', 'effort', 'fast', 'status']],
  ['project', ['add-dir', 'init', 'memory', 'code-review', 'review', 'security-review', 'remote-control']],
  ['setup', ['config', 'theme', 'permissions', 'mcp', 'agents', 'plugin', 'keybindings', 'hooks', 'statusline', 'ide']],
]

/** The six colors the Control tab edits, and the theme keys each one sets. */
const COLOR_KEYS: readonly (readonly [string, string, readonly string[]])[] = [
  ['text', 'text', ['text']],
  ['dim', 'dim', ['inactive']],
  ['accent', 'accent', ['pink_FOR_SUBAGENTS_ONLY', 'briefLabelYou', 'autoAccept']],
  ['message', 'your message', ['userMessageBackground', 'userMessageBackgroundHover']],
  ['success', 'success', ['success', 'green_FOR_SUBAGENTS_ONLY', 'bashBorder']],
  ['error', 'error', ['error', 'red_FOR_SUBAGENTS_ONLY']],
]
type ColorDraft = { preset: string; colors: Record<string, string> }
const COLOR_PRESETS: Record<string, { base: string; colors: Record<string, string> }> = {
  dark: {
    base: 'dark',
    colors: { text: '#f8f8f2', dim: '#7c84b0', accent: '#ff79c6', message: '#3d2f52', success: '#50fa7b', error: '#ff5555' },
  },
  light: {
    base: 'light',
    colors: { text: '#1e1f29', dim: '#5c6370', accent: '#c4146f', message: '#efe4fb', success: '#1a7f37', error: '#cf222e' },
  },
  contrast: {
    base: 'dark',
    colors: { text: '#ffffff', dim: '#b8bfe6', accent: '#ff5fd2', message: '#4b2d6e', success: '#5cff8a', error: '#ff4d4d' },
  },
  '16-color': {
    base: 'dark',
    colors: { text: '#ffffff', dim: '#808080', accent: '#ff00ff', message: '#000080', success: '#00ff00', error: '#ff0000' },
  },
}
const MINE_THEME_FILE = 'better-ui-mine.json'
const MINE_THEME_NAME = 'Better UI (mine)'

/** "compact keep the tests" -> { command: "compact", args: "keep the tests" } */
function splitCommandLine(line: string): { command: string; args: string } {
  const t = line.trim().replace(/^\//, '')
  const at = t.search(/\s/)
  return at < 0 ? { command: t, args: '' } : { command: t.slice(0, at), args: t.slice(at + 1).trim() }
}

async function recordRecent($: CoreEngineInterface, name: string): Promise<void> {
  if (name === '' || name === 'better-ui') return
  const list = await update($, recent, l => [name, ...l.filter(x => x !== name)].slice(0, 20))
  await $.store.set('recent', list)
}

/** Runs a pinned or listed command line from the panel, as if typed. */
async function runCommandLine($: CoreEngineInterface, line: string): Promise<void> {
  const { command, args } = splitCommandLine(line)
  if (command === '') return
  try {
    await $.command.run(args === '' ? { command } : { command, args })
    await recordRecent($, command)
  } catch (err) {
    say($, `/${command}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function setPins($: CoreEngineInterface, change: (l: string[]) => string[]): Promise<void> {
  const list = await update($, pins, l => change([...l]))
  await $.store.set('pins', list)
}

async function setFold($: CoreEngineInterface, key: string, open: boolean): Promise<void> {
  const map = await update($, folds, m => ({ ...m, [key]: open }))
  await $.store.set('folds', map)
}

async function setColors($: CoreEngineInterface, draft: ColorDraft): Promise<void> {
  await update($, colorDraft, () => draft)
  await $.store.set('colors', draft)
}

/** Writes "Better UI (mine)": the bundled theme with the six edited colors laid over it. */
async function saveMineTheme($: CoreEngineInterface): Promise<void> {
  try {
    const draft = await read($, colorDraft)
    const bundled = rec(JSON.parse(String(await $.fs.read(`${$.plugin.root}/themes/better-ui.json`))))
    const overrides: Record<string, unknown> = { ...rec(bundled.overrides) }
    for (const [id, , keys] of COLOR_KEYS) {
      const hex = draft.colors[id]
      if (hex !== undefined) for (const k of keys) overrides[k] = hex
    }
    const theme = {
      name: MINE_THEME_NAME,
      base: COLOR_PRESETS[draft.preset]?.base ?? 'dark',
      overrides,
    }
    const kb = await keybindingsPath($)
    const dir = kb.slice(0, kb.length - 'keybindings.json'.length) + 'themes'
    await $.fs.write(`${dir}/${MINE_THEME_FILE}`, JSON.stringify(theme, null, 2) + '\n')
    say($, `Saved "${MINE_THEME_NAME}". Pick it in /theme to use it.`)
  } catch (err) {
    say($, `Theme not saved: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const register: Register = on => {
  let toolsThisTurn = 0
  let errorsThisTurn = 0
  let pendingPromptId: string | undefined
  let lastPromptText = ''
  let replyLinesThisTurn = 0
  let ticker: Timer | undefined
  let companionTimer: Timer | undefined
  let companionStep = 0
  let companionMisses = 0
  /** Set while Overview draws the figure: whether the bubble strip fits beside it. */
  let companionDrawn: { bubbles: boolean } | undefined
  let companionShown = ''
  /** The main loop's tool calls in flight that have a loop of their own, by call id. */
  const avatarTools = new Map<string, AvatarState>()
  let avatarHeld: { state: AvatarState; step: number } | undefined
  let avatarState: AvatarState = 'idle'
  let avatarSince = 0
  let avatarAgents = 0
  /** How the last turn ended and its errors; undefined once the next turn starts. */
  let avatarLast: { outcome: 'done' | 'stopped' | null; errors: number } | undefined
  /** What the figure shows now: a running tool's loop, else agents, thinking or idle; and the bubbles. */
  const avatarNow = (working: boolean): { state: AvatarState; t: number; ev: AvatarEvents } => {
    const active = [...avatarTools.values()]
    const held =
      working && avatarHeld !== undefined && companionStep - avatarHeld.step <= AVATAR_HOLD_STEPS ? avatarHeld.state : undefined
    const state: AvatarState = active.includes('writing')
      ? 'writing'
      : active.includes('computer')
        ? 'computer'
        : (held ?? (avatarAgents > 0 ? 'agents' : working ? 'thinking' : 'idle'))
    // A loop starts over only when the activity changes.
    if (state !== avatarState) {
      avatarState = state
      avatarSince = companionStep
    }
    const ev: AvatarEvents = {
      outcome: working ? null : (avatarLast?.outcome ?? null),
      agents: avatarAgents,
      errors: working ? errorsThisTurn : (avatarLast?.errors ?? 0),
    }
    return { state, t: (companionStep - avatarSince) * COMPANION_MS, ev }
  }
  /** The first and last control of the tab as last drawn, the header's dots left out. */
  let ring: { first?: string; last?: string } = {}
  let lastRateWarn = 0
  const seenNotices = new Set<string>()

  // ---- lifecycle ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'better-ui',
      description: 'Show or hide the Better UI panel (its data is kept while hidden)',
      argumentHint: '[open|close]',
      immediate: true,
    })

    const stored = rec(await $.store.get('prefs'))
    const merged: Prefs = {
      ...DEFAULT_PREFS,
      ...Object.fromEntries(Object.entries(stored).filter(([k]) => k in DEFAULT_PREFS)),
    }
    if (typeof merged.skin !== 'string' || !(merged.skin in SKINS)) merged.skin = 'line'
    await update($, prefs, () => merged)
    await update($, running, () => null)

    const storedPins = await $.store.get('pins')
    const storedRecent = await $.store.get('recent')
    const storedFolds = await $.store.get('folds')
    const storedColors = rec(await $.store.get('colors'))
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null)
    let startPins = strings(storedPins) ?? [...DEFAULT_PINS]
    if (Number((await $.store.get('pinsVersion')) ?? 1) < 2) {
      if (!startPins.includes('fork')) {
        const at = startPins.indexOf('context')
        startPins = at >= 0 ? startPins.map(x => (x === 'context' ? 'fork' : x)) : [...startPins, 'fork']
        await $.store.set('pins', startPins)
      }
      await $.store.set('pinsVersion', 2)
    }
    await update($, pins, () => startPins)
    await update($, recent, () => strings(storedRecent) ?? [])
    await update($, folds, () =>
      Object.fromEntries(Object.entries(rec(storedFolds)).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>,
    )
    const preset = typeof storedColors.preset === 'string' && storedColors.preset in COLOR_PRESETS ? storedColors.preset : 'dark'
    const savedColors = Object.fromEntries(
      Object.entries(rec(storedColors.colors)).filter(([, v]) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)),
    ) as Record<string, string>
    await update($, colorDraft, () => ({ preset, colors: { ...(COLOR_PRESETS[preset]?.colors ?? {}), ...savedColors } }))

    // One after the other: both rewrite keybindings.json.
    void syncBindings($, 'focus', merged.hotkey, false).then(() => syncBindings($, 'arrows', merged.lockArrows, false))
    void installThemes($)
    // Only ever turns the shortcut off by itself; turning it on is the person's switch.
    if (merged.leftArrowOff) void syncLeftArrow($, false, false)
    if (!(await read($, hidden)) && !(await read($, mini))) void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  // /better-ui toggles between the pane and its one-line band; /better-ui open,
  // /better-ui min and /better-ui close are explicit. Everything it shows lives in
  // $.state, so neither minimizing nor closing loses anything.
  on('command.run', { command: 'better-ui' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (arg === 'close' || arg === 'hide') {
      await update($, mini, () => false)
      await update($, hidden, () => true)
      await $.ui.close({ id: PANE })
      return { text: 'Better UI closed. Its data is kept; /better-ui brings it back.' }
    }
    if (arg === 'min' || arg === 'minimize' || (arg === '' && isOpen)) {
      await minimize($)
      return { text: 'Better UI minimized. Its data is kept; /better-ui brings it back, /better-ui close closes it.' }
    }
    return { text: await expand($) }
  })

  // The person's own close (the x, ctrl+x x) closes for good: no band, and a
  // reload keeps it closed. The mod's own close (a minimize) passes through.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') {
      await update($, mini, () => false)
      await update($, hidden, () => true)
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // Every command run, typed or clicked, lands in Control's recent list.
  on('command.run', async ($, e, next) => {
    const out = await next(e)
    void recordRecent($, e.command)
    return out
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || !(await read($, prefs)).lockArrows) return next(e)
    // Never onto the engine's own stops, which lead out of the panel.
    if (e.element === undefined) return {}
    // Up and Down walk the tab's controls, not the header's dots (Left and Right
    // change tab). The ring's two ends are dots a key can reach: land past them.
    const to = e.element === `dot:${TABS[0]}` ? ring.first : e.element === `dot:${TABS[TABS.length - 1]}` ? ring.last : e.element
    if (to === undefined) return {}
    return next(to === e.element ? e : { ...e, element: to })
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // Left and Right are bound to the pane's Home and End moves (ARROW_BINDINGS),
  // which ask for the whole tree's rows: change tab and leave the window alone.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    const whole = e.by !== 0 && Math.abs(e.by) >= e.contentRows
    if (e.origin.kind !== 'person' || e.pointer !== undefined || !whole || !(await read($, prefs)).lockArrows) return next(e)
    const by = e.by < 0 ? -1 : 1
    await update($, tab, cur => {
      const i = Math.max(0, (TABS as readonly string[]).indexOf(cur))
      return TABS[(i + by + TABS.length) % TABS.length] ?? 'Overview'
    })
    return {}
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  // ---- the minimized line above the prompt --------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, mini))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [p, run, turnList, noteList, pct, liveAgents] = await Promise.all([
      read($, prefs),
      read($, running),
      read($, turns),
      read($, notices),
      contextPercent($),
      liveAgentCount($),
    ])
    const skin = skinOf(p.skin)
    const now = await $.clock.now()
    const pctColor = pct === null ? 'subtle' : pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
    const elapsed = run === null ? 0 : Math.round((now - run.startedAt) / 1000)
    const turnText = run !== null ? `turn ${turnList.length + 1}` : `turn ${turnList[turnList.length - 1]?.n ?? 0}`
    const latest = noteList[noteList.length - 1]
    return (
      <Box flexDirection="row" gap={1} width="100%">
        <Box flexShrink={0} flexDirection="row" gap={1}>
          <Text color={run === null ? 'success' : 'warning'}>{run === null ? skin.ok : skin.run}</Text>
          <Text bold>{run === null ? 'idle' : `working ${fmtSeconds(elapsed)}`}</Text>
          <Text dimColor>·</Text>
          <Text dimColor>context</Text>
          <Text color={pctColor}>{pct === null ? '—' : `${pct}%`}</Text>
          <Text dimColor>· {turnText}</Text>
          <Text color={liveAgents > 0 ? 'warning' : 'subtle'}>
            · {liveAgents} {liveAgents === 1 ? 'agent' : 'agents'}
          </Text>
        </Box>
        <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
          {latest !== undefined && (
            <Text dimColor wrap="truncate-end">
              · {latest.text}
            </Text>
          )}
        </Box>
        <Box flexShrink={0}>
          <Button key="expand" label="open" onPress={() => void expand($)} />
        </Box>
      </Box>
    )
  })



  on('session.append', { door: 'prompt' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      pendingPromptId = e.uuid
      lastPromptText = e.message.content
        .filter(b => b.type === 'text')
        .map(b => str(rec(b).text) ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120)
      await update($, prompts, map => {
        const entries = Object.entries({ ...map, [e.uuid]: now })
        return Object.fromEntries(entries.slice(-300))
      })
      await update($, running, r => (r !== null && r.promptId === undefined ? { ...r, promptId: e.uuid } : r))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const text = e.message.content
        .filter(b => b.type === 'text')
        .map(b => str(rec(b).text) ?? '')
        .join('\n')
        .trim()
      if (text !== '') replyLinesThisTurn += text.split('\n').length
    }
    return next(e)
  }).catch(($, e, next) => (next.called ? undefined : next(e)))

  on('session.append', { door: 'notice' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const text = e.message.content
        .filter(b => b.type === 'text')
        .map(b => str(rec(b).text) ?? '')
        .join(' ')
        .trim()
      if (text !== '' && !seenNotices.has(text)) {
        seenNotices.add(text)
        const now = await $.clock.now()
        const o = e.origin as { kind?: string; name?: string }
        const source = o.kind === 'plugin' ? ('plugin' as const) : o.kind === 'hook' ? ('hook' as const) : undefined
        const from = o.kind === 'plugin' && typeof o.name === 'string' ? o.name : undefined
        await update($, notices, list => [...list, { text, command: null, at: now, source, from }].slice(-NOTICES_KEPT))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- turns ---------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      void liveAgentCount($).then(n => {
        avatarAgents = n
      })
      return next(e)
    }
    avatarLast = undefined
    const now = await $.clock.now()
    toolsThisTurn = 0
    errorsThisTurn = 0
    replyLinesThisTurn = 0
    await update($, running, () => ({ startedAt: now, promptId: pendingPromptId }))
    pendingPromptId = undefined
    ticker?.cancel()
    ticker = $.clock.every(500, () => void update($, tick, n => (n + 1) % 1_000_000))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent finished: say which one.
      try {
        const agent = (await $.agent.list()).find(a => a.id === e.agentId)
        say($, `Agent done: ${clip(agent?.description ?? e.agentId, 50)}`)
      } catch {
        /* no agent list: stay quiet */
      }
      void liveAgentCount($).then(n => {
        avatarAgents = n
      })
      return next(e)
    }

    ticker?.cancel()
    ticker = undefined
    const now = await $.clock.now()
    const run = await read($, running)
    await update($, running, () => null)

    const seconds = Math.round(e.durationMs / 1000)
    const tools = toolsThisTurn
    const errors = errorsThisTurn
    const u = e.usage
    const tokens =
      u === undefined
        ? 0
        : u.output_tokens

    const list = await read($, turns)
    const n = (list[list.length - 1]?.n ?? 0) + 1
    const record: TurnRec = {
      n,
      seconds,
      tools,
      errors,
      tokens,
      reason: e.reason,
      promptId: run?.promptId,
      prompt: lastPromptText === '' ? undefined : lastPromptText,
      replyLines: replyLinesThisTurn === 0 ? undefined : replyLinesThisTurn,
      at: now,
    }
    await update($, turns, l => [...l, record].slice(-100))

    const failed = e.reason === 'error' || e.reason === 'refusal'
    avatarLast = {
      outcome: e.isAborted || e.reason === 'aborted' ? 'stopped' : failed ? null : 'done',
      errors: errors + (failed ? 1 : 0),
    }
    const clean = errors === 0 && e.reason === 'answer' && !e.isAborted
    const tot = await update($, totals, t => {
      const streak = clean ? t.streak + 1 : 0
      return { ...t, streak, bestStreak: Math.max(t.bestStreak, streak) }
    })
    if (clean && tot.streak > 0 && tot.streak % 5 === 0) {
      say($, `Streak ×${tot.streak}: ${tot.streak} clean turns in a row`)
    }

    const p = await read($, prefs)
    if (p.alarm) {
      if (e.reason === 'error') void notify($, 'The turn ended with an error.')
      else if (!e.isAborted && seconds >= LONG_TURN_SECONDS) {
        void notify($, `Done after ${fmtSeconds(seconds)} and ${tools} tool calls.`)
      }
    }

    try {
      const usage = await $.session.usage()
      const worst = Math.max(0, ...usage.rateLimits.map(r => r.percentUsed))
      const step = worst >= 95 ? 95 : worst >= 80 ? 80 : 0
      if (step > 0 && step > lastRateWarn) {
        lastRateWarn = step
        say($, `Account usage at ${Math.round(worst)}% of a rate-limit window`)
      }
    } catch {
      /* no usage figures */
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- tool calls ----------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${startedAt}`
    const entry: Activity = { id, tool: e.tool, label: labelOf(e.tool, e), status: 'run', at: startedAt }
    toolsThisTurn += 1
    // The figure follows the main loop's own calls, not a subagent's.
    const loop = e.agentId === undefined ? avatarToolState(e.tool) : undefined
    if (loop !== undefined) avatarTools.set(id, loop)

    await update($, activity, list => [...list, entry].slice(-60))

    const ran = await next(e).finally(() => {
      if (loop === undefined) return
      avatarTools.delete(id)
      avatarHeld = { state: loop, step: companionStep }
    })

    const ms = (await $.clock.now()) - startedAt
    const isError = ran.deny !== undefined || ran.isError === true
    const status: Activity['status'] = isError ? 'err' : 'ok'
    await update($, activity, list => list.map(a => (a.id === id ? { ...a, status, ms } : a)))
    if (isError) {
      errorsThisTurn += 1
    }

    if (!isError && EDIT_TOOLS.has(e.tool)) {
      const input = rec(e)
      const path = str(input.file_path) ?? str(input.notebook_path)
      const created = e.tool === 'Write' ? str(input.content) : undefined
      const createdLines = created === undefined ? [] : created.replace(/\n$/, '').split('\n')
      const counted = countPatch(ran.result)
      const patch = counted ?? (created === undefined ? undefined : { adds: createdLines.length, dels: 0 })
      const diff = patchToDiff(ran.result) ?? (created === undefined ? undefined : newFileDiff(createdLines))
      const changed = (patch?.adds ?? 0) + (patch?.dels ?? 0)
      if (path !== undefined) {
        const done = await read($, turns)
        const turn = (done[done.length - 1]?.n ?? 0) + 1
        const entry: EditRec = { turn, path, adds: patch?.adds ?? 0, dels: patch?.dels ?? 0, at: startedAt }
        if (diff !== undefined) entry.diff = diff
        await update($, edits, list => [...list, entry].slice(-EDITS_KEPT))
        if (changed >= BIG_EDIT_LINES) {
          say($, `Big edit: ${changed} lines in ${shortPath(path)}`)
        }
      }
    }

    if (e.tool === 'Bash' && ran.deny === undefined) {
      const out = rec(ran.result)
      const tests = detectTests(str(rec(e).command) ?? '', str(out.stdout) ?? '', str(out.stderr) ?? '')
      if (tests !== undefined) {
        say($, 
          tests.failed > 0
            ? `Tests: ${tests.failed} failed, ${tests.passed} passed`
            : `Tests: ${tests.passed} passed`,
        )
      }
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A line of context under the permission dialog when a call needs approval.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision !== 'ask' || e.tool_use_id === undefined) return verdict
    const id = e.tool_use_id
    let text: string | undefined
    if (e.tool === 'Bash') {
      const risk = riskOf(str(rec(e.input).command) ?? '')
      if (risk !== undefined) text = `⚠ ${risk}`
    } else if (EDIT_TOOLS.has(e.tool)) {
      const path = str(rec(e.input).file_path) ?? str(rec(e.input).notebook_path)
      const mine = path === undefined ? [] : (await read($, edits)).filter(x => x.path === path)
      if (mine.length > 0) {
        const adds = mine.reduce((n, x) => n + x.adds, 0)
        const dels = mine.reduce((n, x) => n + x.dels, 0)
        text = `Edited ${mine.length}× this session (+${adds} −${dels})`
      }
    }
    if (text !== undefined) {
      // The dialog opens just after the verdict: post the line once it is there.
      const line = text
      $.clock.after(250, () => $.ui.notice(id, line))
      $.clock.after(1200, () => $.ui.notice(id, line))
    }
    return verdict
  }).catch(($, e, next) => next(e))

  // ---- prompt box ----------------------------------------------------------

  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    if (!(await read($, prefs)).paint) return r
    return { ...r, decorations: [...(r.decorations ?? []), ...decoratePrompt(r.text)] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    // The only thing the mod adds to Claude Code's hint line: "rc on" while Remote Control is on.
    if ((await rcCached($)) !== true) return next(e)
    return next({ ...e, props: { ...e.props, tail: 'rc on' } })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (e.props.modes.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={1}>
        {e.props.modes.map(mode => {
          const m = mode.toLowerCase()
          const color = m.includes('plan') ? 'planMode' : m.includes('auto') ? 'autoAccept' : 'subtle'
          return (
            <Text color={color} bold>
              [{mode.toUpperCase()}]
            </Text>
          )
        })}
      </Box>
    )
  })

  // While a turn runs: frame, the engine's word, elapsed, the tool running
  // now (in its kind colour), and how many tools so far.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const [p, run, t, acts] = await Promise.all([
      read($, prefs),
      read($, running),
      read($, tick),
      read($, activity),
    ])
    if (run === null) return next(e)
    const skin = skinOf(p.skin)
    const { Box, Text } = $.ui.resolve(e)
    const frame = skin.spin[t % skin.spin.length] ?? skin.run
    const elapsed = Math.max(0, Math.round(((await $.clock.now()) - run.startedAt) / 1000))
    const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
    const current = [...acts].reverse().find(a => a.status === 'run')
    const mood = 'pink_FOR_SUBAGENTS_ONLY'
    const idleWord =
      e.props.mode === 'thinking' ? 'thinking' : e.props.mode === 'responding' ? 'writing' : 'waiting for the model'
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={mood}>{frame}</Text>
        <Text color={mood} bold>
          {e.props.message ?? e.props.word}
        </Text>
        <Text color="yellow_FOR_SUBAGENTS_ONLY">{clock}</Text>
        <Text color="subtle">│</Text>
        {current !== undefined ? (
          <Box flexDirection="row" columnGap={1} flexShrink={1}>
            <Text color={KIND_COLOR[toolKind(current.tool)]}>
              {toolIcon(skin, current.tool)} {current.tool}
            </Text>
            <Text wrap="truncate-end">{current.label}</Text>
          </Box>
        ) : (
          <Text color="inactive">{idleWord}</Text>
        )}
        <Text color="subtle">│</Text>
        <Text color="cyan_FOR_SUBAGENTS_ONLY">
          {toolsThisTurn} {toolsThisTurn === 1 ? 'tool' : 'tools'}
        </Text>
      </Box>
    )
  })

  // When a turn ends: a rule that closes the reply and carries its result.
  // The turn's figures live in Overview's "last turn": the transcript keeps no
  // turn line. Expanded views and "waiting for" lines pass through.
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.isExpanded === true || e.props.waitingFor !== undefined) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (e.props.origin.kind !== 'composer') return next(e)
    const [p, map] = await Promise.all([read($, prefs), read($, prompts)])
    const skin = skinOf(p.skin)
    const at = map[e.requestId]
    const { Box, Text } = $.ui.resolve(e)
    // A tinted block: one blank row of the tint above and below, two columns
    // each side, a 'you ──── 14:02' header, then the text. One blank row
    // outside, above it, parts it from the reply before.
    void skin
    return (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="column" backgroundColor={USER_TINT} paddingX={2} paddingY={1} rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={USER_ACCENT} bold>
              you
            </Text>
            <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
              <Text color={USER_RULE} wrap="wrap">
                {'─'.repeat(400)}
              </Text>
            </Box>
            {at !== undefined && <Text color="subtle">{hhmm(at)}</Text>}
          </Box>
          <Text wrap="wrap">{e.props.text}</Text>
        </Box>
      </Box>
    )
  })

  // Claude's text: a 'claude ────' header on the first block of a reply, the
  // body indented two columns, a size footer on long ones. A blank row above
  // and below sets text apart from tool rows, which stay tight together.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.props.isSummary === true) return next(e)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1} width="100%">
        {e.props.isFirstOfReply && (
          <Box flexDirection="row" columnGap={1}>
            <Text color="briefLabelClaude" bold>
              ● claude
            </Text>
            <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
              <Text color="claude" dimColor wrap="wrap">
                {'─'.repeat(400)}
              </Text>
            </Box>
          </Box>
        )}
        <Box paddingLeft={2} flexDirection="column" width="100%" flexShrink={1}>
          <Markdown text={e.props.text} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const p = await read($, prefs)
    const text = `${e.props.text}${e.props.command === null ? '' : ` ${e.props.command}`}`.trim()
    if (text !== '' && !seenNotices.has(text)) {
      seenNotices.add(text)
      const command = e.props.command
      // A render hook must not write state: record the notice right after the draw.
      $.clock.after(1, () => {
        void (async () => {
          const now = await $.clock.now()
          await update($, notices, list => [...list, { text: e.props.text, command, at: now }].slice(-NOTICES_KEPT))
        })()
      })
    }
    if (!p.hideNotices) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = await read($, prefs)
    if (e.props.isExpanded === true || !p.compactRows) return next(e)
    const acts = await read($, activity)
    const pr = e.props
    const ui = $.ui.resolve(e)
    const row = await callRow($, ui, p, acts, {
      id: pr.tool_use_id,
      tool: pr.tool,
      input: pr.input,
      output: pr.output,
      isRunning: pr.isRunning,
      isErrored: pr.isErrored,
      isInterrupted: pr.isInterrupted,
    })
    return toolFrame(ui.Box, row)
  })

  // Claude Code folds runs of reads, searches and shell commands into one
  // count line. Draw each call of the run as its own row instead.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const p = await read($, prefs)
    if (e.props.isExpanded || !p.compactRows || e.props.calls.length === 0) return next(e)
    const acts = await read($, activity)
    const ui = $.ui.resolve(e)
    const drawn = await Promise.all(
      e.props.calls.map(c =>
        callRow($, ui, p, acts, {
          id: c.tool_use_id,
          tool: c.tool,
          input: c.input,
          output: c.output,
          isRunning: c.isRunning,
          isErrored: c.isErrored,
          isInterrupted: c.isInterrupted,
        }),
      ),
    )
    return toolFrame(ui.Box, drawn)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = await read($, prefs)
    if (e.props.isExpanded === true || e.props.isErrored || !p.compactRows) return next(e)
    // The summary now sits in the call's own row (its result column).
    if (resultSummary(e.props.tool, e.props.output) === undefined) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // ---- the pane ------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code, Input } = elements
    // The cell grid is the terminal's alone; elsewhere the companion is left out.
    const Raster = 'Raster' in elements ? elements.Raster : undefined
    const cols = Math.max(24, e.props.bodyColumns)
    const now = await $.clock.now()
    const [p, current, editList, turnList, noteList, run, expanded, fold] = await Promise.all([
      read($, prefs),
      read($, tab),
      read($, edits),
      read($, turns),
      read($, notices),
      read($, running),
      read($, expandedFile),
      read($, folds),
    ])
    const accent = 'pink_FOR_SUBAGENTS_ONLY'
    const active = (TABS as readonly string[]).includes(current) ? (current as Tab) : 'Overview'
    const at = TABS.indexOf(active)
    const go = (name: Tab) => update($, tab, () => name)
    const step = (by: number) => go(TABS[(at + by + TABS.length) % TABS.length] ?? 'Overview')
    const isOpen = (key: string) => fold[key] ?? DEFAULT_FOLDS[key] ?? false

    // ---- shared pieces
    const rule = (color = 'subtle') => (
      <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        <Text color={color} wrap="wrap">
          {'─'.repeat(400)}
        </Text>
      </Box>
    )
    // Section titles: bold capitals over an accent rule.
    const section = (label: string, right?: string) => (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>
            <Text bold>{label.toUpperCase()}</Text>
          </Box>
          <Box flexGrow={1} />
          {right !== undefined && (
            <Box flexShrink={0}>
              <Text color="inactive">{right}</Text>
            </Box>
          )}
        </Box>
        <Box flexDirection="row">{rule(accent)}</Box>
      </Box>
    )
    // A section that folds: + closed, − open; the whole title row toggles it.
    const foldSection = (key: string, label: string, right?: string) => {
      const open = isOpen(key)
      return (
        <Box flexDirection="column">
          <Button key={`fold:${key}`} plain onPress={() => void setFold($, key, !open)}>
            <Text color={accent} bold>
              {open ? '− ' : '+ '}
            </Text>
            <Text bold>{label.toUpperCase()}</Text>
            {right !== undefined && <Text color="inactive">{`  ${right}`}</Text>}
          </Button>
          <Box flexDirection="row">{rule(open ? accent : 'subtle')}</Box>
        </Box>
      )
    }
    const LABEL = 9
    const meter = (pct: number, tone: string) => {
      const w = Math.max(6, cols - LABEL - 6)
      const filled = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
      return (
        <Text>
          <Text color={tone}>{'▰'.repeat(filled)}</Text>
          <Text color="subtle">{'▱'.repeat(w - filled)}</Text>
        </Text>
      )
    }
    const field = (label: string, value: any, right?: any) => (
      <Box flexDirection="row">
        <Box width={LABEL} flexShrink={0}>
          <Text color="inactive">{label}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {typeof value === 'string' ? <Text wrap="truncate-end">{value}</Text> : value}
        </Box>
        {right !== undefined && (
          <Box width={5} flexShrink={0} justifyContent="flex-end">
            {right}
          </Box>
        )}
      </Box>
    )
    const levelTone = (pct: number) => (pct >= 90 ? 'error' : pct >= 70 ? 'warning' : 'success')
    const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    const mins = (secs: number) => (secs < 60 ? '<1m' : `${Math.round(secs / 60)}m`)

    // ---- top bar: the tab's name, rc while on, then one dot per tab (clickable)
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>
            <Text color={accent} bold>
              {active}
            </Text>
          </Box>
          <Box flexGrow={1} />
          {TABS.map(name => (
            <Button key={`dot:${name}`} plain onPress={() => go(name)}>
              <Text color={name === active ? accent : 'inactive'}>{name === active ? '●' : '·'}</Text>
            </Button>
          ))}
        </Box>
        <Box flexDirection="row">{rule()}</Box>
      </Box>
    )

    // ---- footer: the hotkeys live on buttons that are not drawn
    const footer = (
      <Box flexDirection="row">
        {active === 'Overview' && Raster !== undefined && e.props.placement === 'dock' && (
          <Box flexShrink={0}>
            <Button key="companion:toggle" plain onPress={() => void savePrefs($, cur => ({ ...cur, companion: !cur.companion }))}>
              <Text color={p.companion ? accent : 'inactive'}>{p.companion ? '▣ avatar' : '□ avatar'}</Text>
            </Button>
          </Box>
        )}
        <Box flexGrow={1} />
        <Box display="none">
          {TABS.map((name, i) => (
            <Button key={`tab:${name}`} hotkey={String(i + 1)} plain label={name} onPress={() => go(name)} />
          ))}
          <Button key="tab:prev" hotkey="a" plain label="prev" onPress={() => step(-1)} />
          <Button key="tab:next" hotkey="d" plain label="next" onPress={() => step(1)} />
        </Box>
        {/* m only works while the panel holds the keys, so it only shows then. */}
        {e.props.isFocused ? (
          <Box flexDirection="row">
            <Button key="minimize" hotkey="m" plain label="minimize" onPress={() => void minimize($)} />
            <Text color="inactive"> · a/d tabs · esc to leave</Text>
          </Box>
        ) : (
          <Text color="inactive">{`${p.hotkey ? HOTKEY : 'ctrl+x tab'} to enter`}</Text>
        )}
      </Box>
    )

    let body
    switch (active) {
      case 'Overview': {
        const [pct, liveAgents, engine] = await Promise.all([contextPercent($), liveAgentCount($), engineVersion($)])
        // While a turn runs, redraw with the clock so "working 0:42" keeps counting.
        if (run !== null) await read($, tick)
        const elapsed = run === null ? 0 : Math.max(0, Math.round((now - run.startedAt) / 1000))
        const last = turnList[turnList.length - 1]
        const turnNo = run !== null ? turnList.length + 1 : (last?.n ?? 0)
        const idleFor = last === undefined ? undefined : Math.max(0, Math.round((now - last.at) / 1000))
        const notesOpen = isOpen('notices')
        const NOTES_SHOWN = 3
        const visible = p.showOwnNotices ? noteList : noteList.filter(nt => nt.source !== 'ui')
        const shown = notesOpen ? [...visible].reverse() : visible.slice(-NOTES_SHOWN).reverse()
        const more = visible.length - shown.length

        // The figure stands on the footer, in the rows the sections above leave free.
        const noteRows =
          visible.length === 0
            ? 1
            : shown.reduce((n, nt) => n + Math.max(1, Math.ceil(nt.text.length / Math.max(8, cols - 8))), 0) +
              (more > 0 || (notesOpen && visible.length > NOTES_SHOWN) ? 1 : 0)
        // header 2 · NOW 7 · LAST TURN 6 · NOTICES title 2 · footer 1 · five gaps, and one more above the figure
        const usedRows = 2 + 7 + 6 + 2 + noteRows + 1 + 5 + 1
        const freeRows = e.props.scroll.bodyRows - usedRows
        const fit =
          p.companion && Raster !== undefined && e.props.placement === 'dock' && AVATAR_H / 2 <= freeRows && AVATAR_W <= cols
            ? { bubbles: AVATAR_W + BUBBLE_W <= cols }
            : undefined
        companionDrawn = fit
        avatarAgents = liveAgents
        const picture = (() => {
          if (fit === undefined) return undefined
          const a = avatarNow(run !== null)
          return avatarCells(a.state, a.t, fit.bubbles ? a.ev : null)
        })()
        if (fit !== undefined && companionTimer === undefined) {
          companionMisses = 0
          companionTimer = $.clock.every(COMPANION_MS, () => {
            void (async () => {
              companionStep += 1
              // Agents starting and stopping set the count; this catches what those miss.
              if (companionStep % 50 === 0) avatarAgents = await liveAgentCount($)
              const working = (await read($, running)) !== null
              const drawn = companionDrawn
              const a = avatarNow(working)
              const ev = drawn?.bubbles ? a.ev : null
              const key = avatarKey(a.state, a.t, ev)
              // Repaint only when the picture changes; one check a second tells whether it is still on screen.
              if (drawn === undefined || (key === companionShown && companionStep % 10 !== 0)) {
                if (drawn === undefined) companionMisses += 1
                if (companionMisses >= 30) {
                  companionTimer?.cancel()
                  companionTimer = undefined
                  clearAvatarCells()
                }
                return
              }
              const r = await $.ui.blit({ requestId: PANE, key: COMPANION_KEY, ...avatarCells(a.state, a.t, ev) })
              companionShown = r.deny === undefined ? key : ''
              // Not on screen (another tab, minimized, closed): stop after about three seconds.
              companionMisses = r.deny === undefined ? 0 : companionMisses + 1
              if (companionMisses >= 3) {
                companionTimer?.cancel()
                companionTimer = undefined
                clearAvatarCells()
              }
            })().catch(() => {})
          })
        }
        const result =
          last === undefined
            ? null
            : last.reason === 'aborted'
              ? { text: `■ stopped after ${fmtSeconds(last.seconds)}`, tone: 'warning' }
              : last.reason === 'error' || last.reason === 'refusal'
                ? { text: `× ${last.reason} after ${fmtSeconds(last.seconds)}`, tone: 'error' }
                : { text: `done in ${fmtSeconds(last.seconds)}`, tone: 'success' }
        body = (
          <Box flexDirection="column" rowGap={1} flexGrow={1}>
            <Box flexDirection="column">
              {section('now')}
              {field(
                'state',
                run === null ? (
                  <Text>
                    <Text color="success" bold>
                      idle
                    </Text>
                    {idleFor !== undefined && <Text color="inactive"> for {mins(idleFor)}</Text>}
                  </Text>
                ) : (
                  <Text>
                    <Text color="warning" bold>
                      working
                    </Text>
                    <Text color="warning"> {clock(elapsed)}</Text>
                  </Text>
                ),
              )}
              {field(
                'context',
                pct === null ? '—' : meter(pct, levelTone(pct)),
                <Text color={pct === null ? 'inactive' : levelTone(pct)}>{pct === null ? '' : `${pct}%`}</Text>,
              )}
              {field('turn', String(turnNo))}
              {field(
                'agents',
                <Text color={liveAgents > 0 ? 'purple_FOR_SUBAGENTS_ONLY' : 'inactive'}>
                  {liveAgents > 0 ? `${liveAgents} running` : 'none'}
                </Text>,
              )}
              {field('claude', engine)}
            </Box>
            <Box flexDirection="column">
              {section('last turn', last === undefined ? undefined : `turn ${last.n}`)}
              {last === undefined || result === null ? (
                <Text color="inactive">No turns finished yet.</Text>
              ) : (
                <Box flexDirection="column">
                  {field('result', <Text color={result.tone}>{result.text}</Text>)}
                  {field(
                    'tools',
                    <Text>
                      {last.tools}
                      {last.errors > 0 && <Text color="error"> · {last.errors} failed</Text>}
                    </Text>,
                  )}
                  {field('written', `↓ ${fmtTokens(last.tokens)} tok`)}
                  {field('reply', last.replyLines === undefined ? '—' : `${last.replyLines} lines`)}
                </Box>
              )}
            </Box>
            <Box flexDirection="column">
              <Box flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Box flexShrink={0}>
                    <Text bold>NOTICES</Text>
                  </Box>
                  <Box flexGrow={1} />
                  <Box flexShrink={0}>
                    <Text color="inactive">{visible.length}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button
                      key="notes:own"
                      plain
                      onPress={() => void savePrefs($, cur => ({ ...cur, showOwnNotices: !cur.showOwnNotices }))}
                    >
                      <Text color={p.showOwnNotices ? accent : 'inactive'} bold={p.showOwnNotices}>
                        {p.showOwnNotices ? '▣' : '□'}
                      </Text>
                    </Button>
                  </Box>
                </Box>
                <Box flexDirection="row">{rule(accent)}</Box>
              </Box>
              {visible.length === 0 && <Text color="inactive">Nothing yet.</Text>}
              {shown.map((nt, i) => (
                <Box key={`note:${i}`} flexDirection="row" columnGap={1}>
                  <Box width={5} flexShrink={0}>
                    <Text color="inactive">{hhmm(nt.at)}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1} flexDirection="column">
                    <Text wrap="wrap">{nt.text}</Text>
                  </Box>
                  {nt.command !== null && (
                    <Box flexShrink={0}>
                      <Button key={`notecmd:${i}`} plain onPress={() => void runCommandLine($, nt.command ?? '')}>
                        <Text color="cyan_FOR_SUBAGENTS_ONLY">{nt.command}</Text>
                      </Button>
                    </Box>
                  )}
                  {nt.source !== undefined && (
                    <Box flexShrink={0}>
                      {nt.source === 'ui' ? (
                        <Text color={accent}>▣</Text>
                      ) : (
                        <Text color="inactive">{nt.from ?? nt.source}</Text>
                      )}
                    </Box>
                  )}
                </Box>
              ))}
              {!notesOpen && more > 0 && (
                <Box paddingLeft={6}>
                  <Button key="notes:more" plain onPress={() => void setFold($, 'notices', true)}>
                    <Text color={accent}>+ {more} more</Text>
                  </Button>
                </Box>
              )}
              {notesOpen && visible.length > NOTES_SHOWN && (
                <Box paddingLeft={6}>
                  <Button key="notes:fewer" plain onPress={() => void setFold($, 'notices', false)}>
                    <Text color={accent}>− fewer</Text>
                  </Button>
                </Box>
              )}
            </Box>
            {picture !== undefined && Raster !== undefined && (
              <Box flexDirection="column" flexGrow={1} justifyContent="flex-end" alignItems="center">
                <Raster key={COMPANION_KEY} columns={picture.columns} rows={picture.rows} cells={picture.cells} />
              </Box>
            )}
          </Box>
        )
        break
      }

      case 'Usage': {
        let usage
        try {
          usage = await $.session.usage()
        } catch {
          usage = undefined
        }
        const limits = usage?.rateLimits ?? []
        const pct = usage?.context.percent ?? 0
        const written = turnList.reduce((n, t) => n + t.tokens, 0)
        const worked = turnList.reduce((n, t) => n + t.seconds, 0)
        const longName = (kind: string) => {
          const short = limitName(kind)
          return short === '5h' ? '5 hours' : short === '7d' ? '7 days' : short
        }
        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              {section('this session')}
              {field('context', meter(pct, levelTone(pct)), <Text color={levelTone(pct)}>{pct}%</Text>)}
              {usage !== undefined &&
                field(
                  '',
                  <Text color="inactive">
                    {usage.context.tokens !== undefined ? fmtTokens(usage.context.tokens) : '—'} of{' '}
                    {fmtTokens(usage.context.window)} tokens
                  </Text>,
                )}
              {field('written', <Text color="cyan_FOR_SUBAGENTS_ONLY">↓ {fmtTokens(written)} tok</Text>)}
              {field(
                'turns',
                <Text>
                  {turnList.length}
                  <Text color="inactive">
                    {' '}
                    · {mins(worked)} working{usage !== undefined ? ` · since ${hhmm(usage.startedAt)}` : ''}
                  </Text>
                </Text>,
              )}
            </Box>
            <Box flexDirection="column">
              {section('account limits')}
              {limits.length === 0 && <Text color="inactive">No limit figures (API key, or no reading yet).</Text>}
              {limits.map(r => (
                <Box key={`rl:${r.kind}`} flexDirection="column">
                  {field(
                    longName(r.kind),
                    meter(r.percentUsed, levelTone(r.percentUsed)),
                    <Text color={levelTone(r.percentUsed)}>{Math.round(r.percentUsed)}%</Text>,
                  )}
                  {r.resetsAt !== undefined && field('', <Text color="inactive">resets {relTime(r.resetsAt, now)}</Text>)}
                  {extraFields(r, ['kind', 'percentUsed', 'resetsAt']).map(([k, v]) =>
                    field('', <Text color="inactive">{k} {v}</Text>),
                  )}
                </Box>
              ))}
            </Box>
          </Box>
        )
        break
      }

      case 'History': {
        // TURNS: the newest five in fixed columns, the rest behind "+ N more".
        // CHANGED FILES: the picked turn's edits, else the latest turn's.
        const picked = await read($, pickedTurn)
        const allRows = [...turnList].reverse()
        const turnsOpen = isOpen('turns:more')
        const rows = turnsOpen ? allRows.slice(0, 40) : allRows.slice(0, TURNS_SHOWN)
        const moreTurns = allRows.length - rows.length
        const worked = turnList.reduce((n, t) => n + t.seconds, 0)
        const W = { turn: 4, at: 5, tools: 5, marks: 9, took: 4 }
        const textW = Math.max(8, cols - (W.turn + W.at + W.tools + W.marks + W.took) - 5)
        const marksOf = (t: TurnRec) =>
          t.reason === 'aborted'
            ? { text: '■ stopped', tone: 'warning' }
            : t.reason === 'error' || t.reason === 'refusal'
              ? { text: `× ${t.reason}`, tone: 'error' }
              : t.errors > 0
                ? { text: `${t.errors} failed`, tone: 'error' }
                : { text: '', tone: 'inactive' }

        // Which turn CHANGED FILES shows: the picked one, else the one running, else the last.
        const runningNo = run !== null ? (turnList[turnList.length - 1]?.n ?? 0) + 1 : undefined
        const shownNo = picked ?? runningNo ?? turnList[turnList.length - 1]?.n
        type Row = { path: string; adds: number; dels: number; count: number; at: number; diff?: string }
        const merged = new Map<string, Row>()
        for (const x of editList) {
          if (x.turn !== shownNo) continue
          const prev = merged.get(x.path)
          merged.set(x.path, {
            path: x.path,
            adds: (prev?.adds ?? 0) + x.adds,
            dels: (prev?.dels ?? 0) + x.dels,
            count: (prev?.count ?? 0) + 1,
            at: x.at,
            diff: x.diff ?? prev?.diff,
          })
        }
        const fileRows = [...merged.values()].sort((r1, r2) => r2.at - r1.at)
        const oldestKept = editList[0]?.turn
        const tooOld =
          shownNo !== undefined && editList.length >= EDITS_KEPT && oldestKept !== undefined && shownNo < oldestKept
        const fAdds = fileRows.reduce((n, r) => n + r.adds, 0)
        const fDels = fileRows.reduce((n, r) => n + r.dels, 0)
        const shownRec = turnList.find(t => t.n === shownNo)
        const jump = async () => {
          if (shownRec?.promptId === undefined) {
            $.ui.toast(shownNo === undefined ? 'No turn yet' : `Turn ${shownNo}: no prompt row to jump to`)
            return
          }
          const r = await $.ui.scroll({ to: { requestId: shownRec.promptId }, block: 'start' })
          if (r.deny !== undefined) $.ui.toast(`Turn ${shownNo} is no longer on screen`)
        }
        const pathW = Math.max(8, cols - 2 - 16)

        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              {section('turns', `${turnList.length} total · ${mins(worked)} working`)}
              {allRows.length === 0 ? (
                <Text color="inactive">No turns finished yet.</Text>
              ) : (
                <Box flexDirection="column">
                  <Text color="inactive">
                    {'#'.padEnd(W.turn)} {'at'.padEnd(W.at)} {'prompt'.padEnd(textW)} {'tools'.padStart(W.tools)}{' '}
                    {'marks'.padEnd(W.marks)} {'took'.padStart(W.took)}
                  </Text>
                  <Box flexDirection="row">{rule()}</Box>
                  {rows.map(t => {
                    const slow = rateTurn(t.seconds, 0, 'answer') === 'slow'
                    const mark = marksOf(t)
                    const isPicked = t.n === shownNo
                    const bg = isPicked ? 'userMessageBackground' : undefined
                    const words = clip((t.prompt ?? '(prompt not recorded)').replace(/\\s+/g, ' '), textW).padEnd(textW)
                    return (
                      <Button
                        key={`turn:${t.n}`}
                        plain
                        onPress={() => void update($, pickedTurn, cur => (cur === t.n ? null : t.n))}
                      >
                        <Text color={accent} bold backgroundColor={bg}>
                          {String(t.n).padEnd(W.turn)}{' '}
                        </Text>
                        <Text color="inactive" backgroundColor={bg}>
                          {hhmm(t.at).padEnd(W.at)}{' '}
                        </Text>
                        <Text color={t.prompt === undefined ? 'inactive' : 'text'} backgroundColor={bg}>
                          {words}{' '}
                        </Text>
                        <Text backgroundColor={bg}>{String(t.tools).padStart(W.tools)} </Text>
                        <Text color={mark.tone} backgroundColor={bg}>
                          {mark.text.padEnd(W.marks)}{' '}
                        </Text>
                        <Text color={slow ? 'warning' : 'inactive'} backgroundColor={bg}>
                          {mins(t.seconds).padStart(W.took)}
                        </Text>
                      </Button>
                    )
                  })}
                  {moreTurns > 0 && (
                    <Button key="turns:more" plain onPress={() => void setFold($, 'turns:more', true)}>
                      <Text color={accent}>+ {moreTurns} more</Text>
                    </Button>
                  )}
                  {turnsOpen && allRows.length > TURNS_SHOWN && (
                    <Button key="turns:fewer" plain onPress={() => void setFold($, 'turns:more', false)}>
                      <Text color={accent}>− fewer</Text>
                    </Button>
                  )}
                </Box>
              )}
            </Box>

            <Box flexDirection="column">
              {section(
                'changed files',
                shownNo === undefined
                  ? undefined
                  : `turn ${shownNo}${shownNo === runningNo ? ' (running)' : ''} · ${fileRows.length} ${fileRows.length === 1 ? 'file' : 'files'} · +${fAdds} −${fDels}`,
              )}
              {shownNo === undefined ? (
                <Text color="inactive">No turns yet.</Text>
              ) : tooOld ? (
                <Text color="inactive">Turn {shownNo} is too old: its edits are no longer kept.</Text>
              ) : fileRows.length === 0 ? (
                <Text color="inactive">No files changed in turn {shownNo}.</Text>
              ) : (
                fileRows.map(r => {
                  const key = `${shownNo}|${r.path}`
                  const open = expanded === key
                  return (
                    <Box key={`frow:${key}`} flexDirection="column">
                      <Button
                        key={`fbtn:${key}`}
                        plain
                        onPress={() => update($, expandedFile, cur => (cur === key ? null : key))}
                      >
                        <Text color={accent}>{open ? '− ' : '+ '}</Text>
                        <Text bold={open}>{clip(shortPath(r.path), pathW).padEnd(pathW)} </Text>
                        <Text color="success">{`+${r.adds}`.padStart(5)}</Text>
                        <Text color="error">{(r.dels > 0 ? `−${r.dels}` : '').padStart(5)}</Text>
                        <Text color="inactive">{(r.count > 1 ? `${r.count}×` : '').padStart(4)}</Text>
                      </Button>
                      {open && (
                        <Box flexDirection="column" borderStyle="round" borderColor="inactive" borderDimColor paddingX={1}>
                          {r.diff !== undefined ? (
                            <Code format="diff" source={r.diff} path={r.path} wrap="truncate-end" />
                          ) : (
                            <Text color="inactive">No preview for this edit.</Text>
                          )}
                        </Box>
                      )}
                    </Box>
                  )
                })
              )}
              {shownRec?.promptId !== undefined && (
                <Box marginTop={1}>
                  <Button key="turn:jump" plain onPress={jump}>
                    <Text color="inactive">↑ jump to turn {shownNo}'s prompt</Text>
                  </Button>
                </Box>
              )}
            </Box>
          </Box>
        )
        break
      }

      case 'Agents': {
        let agents: Awaited<ReturnType<typeof $.agent.list>> = []
        try {
          agents = await $.agent.list()
        } catch {
          agents = []
        }
        const live = agents.filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')
        const done = agents.filter(a => !live.includes(a))
        const open = (id: string) => async () => {
          const r = await $.ui.view({ agentId: id })
          if (r.deny !== undefined) $.ui.toast(`Cannot open that agent: ${r.deny}`)
        }
        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column" rowGap={1}>
              {section('running', String(live.length))}
              {live.length === 0 && <Text color="inactive">No subagents running.</Text>}
              {live.map(a => (
                <Box key={`live:${a.id}`} flexDirection="column" paddingLeft={1}>
                  <Button key={`agent:${a.id}`} plain onPress={open(a.id)}>
                    <Text color="purple_FOR_SUBAGENTS_ONLY" bold>
                      ◆ {a.name ?? a.type}
                    </Text>
                    <Text color="warning"> {a.status}</Text>
                  </Button>
                  <Box paddingLeft={2}>
                    <Text wrap="truncate-end">{a.description}</Text>
                  </Box>
                </Box>
              ))}
            </Box>
            <Box flexDirection="column">
              {section('finished', String(done.length))}
              {done.length === 0 && <Text color="inactive">None yet this session.</Text>}
              {done
                .slice(-12)
                .reverse()
                .map(a => (
                  <Button key={`done:${a.id}`} plain onPress={open(a.id)}>
                    <Text color="error">{a.status === 'failed' ? '× ' : '  '}</Text>
                    <Text color="inactive">
                      ◆ {a.name ?? a.type} · {clip(a.description, Math.max(10, cols - 20))}
                    </Text>
                  </Button>
                ))}
            </Box>
            <Button key="back" plain label="back to the main conversation" onPress={() => $.ui.view({})} />
          </Box>
        )
        break
      }

      case 'Control': {
        const [pinList, recentList, filter, editing, draft, colorEditing] = await Promise.all([
          read($, pins),
          read($, recent),
          read($, cmdFilter),
          read($, pinEdit),
          read($, colorDraft),
          read($, colorEdit),
        ])
        let commands: Awaited<ReturnType<typeof $.command.list>> = []
        try {
          commands = await $.command.list()
        } catch {
          commands = []
        }
        const byName = new Map(commands.map(c => [c.name, c]))
        const run = (line: string) => () => void runCommandLine($, line)
        const togglePin = (name: string) => () =>
          void setPins($, l => (l.includes(name) ? l.filter(x => x !== name) : [...l, name]))

        // A grid of command buttons, three to a row.
        const cellW = Math.max(8, Math.floor((cols - 2) / 3))
        const grid = (items: string[], keyPrefix: string) => {
          const rows: string[][] = []
          for (let i = 0; i < items.length; i += 3) rows.push(items.slice(i, i + 3))
          return (
            <Box flexDirection="column" paddingLeft={2}>
              {rows.map((row, r) => (
                <Box key={`${keyPrefix}:row:${r}`} flexDirection="row">
                  {row.map(item => (
                    <Box key={`${keyPrefix}:${item}`} width={cellW} flexShrink={0}>
                      <Button key={`${keyPrefix}:btn:${item}`} plain onPress={run(item)}>
                        <Text color="cyan_FOR_SUBAGENTS_ONLY">{clip(`/${item}`, cellW - 1)}</Text>
                      </Button>
                    </Box>
                  ))}
                </Box>
              ))}
            </Box>
          )
        }

        // One listed command: pin mark, name, description.
        const nameW = Math.min(20, Math.max(10, Math.floor(cols / 3)))
        const listRow = (c: { name: string; description: string }, keyPrefix: string) => {
          const pinned = pinList.includes(c.name)
          return (
            <Box key={`${keyPrefix}:${c.name}`} flexDirection="row" paddingLeft={2}>
              <Box width={2} flexShrink={0}>
                <Button key={`${keyPrefix}:pin:${c.name}`} plain onPress={togglePin(c.name)}>
                  <Text color={pinned ? 'warning' : 'inactive'}>{pinned ? '◆' : '◇'}</Text>
                </Button>
              </Box>
              <Box width={nameW} flexShrink={0}>
                <Button key={`${keyPrefix}:run:${c.name}`} plain onPress={run(c.name)}>
                  <Text color="cyan_FOR_SUBAGENTS_ONLY">{clip(`/${c.name}`, nameW - 1)}</Text>
                </Button>
              </Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text color="inactive" wrap="truncate-end">
                  {c.description}
                </Text>
              </Box>
            </Box>
          )
        }
        const group = (label: string, items: { name: string; description: string }[], keyPrefix: string) =>
          items.length === 0 ? null : (
            <Box key={`grp:${keyPrefix}`} flexDirection="column">
              <Box paddingLeft={2}>
                <Text color="inactive">{label}</Text>
              </Box>
              {items.map(c => listRow(c, keyPrefix))}
            </Box>
          )

        // ---- all commands, grouped
        const builtins = commands.filter(c => c.source === 'builtin')
        const mapped = new Set(COMMAND_GROUPS.flatMap(([, names]) => [...names]))
        const q = filter.trim().toLowerCase().replace(/^\//, '')
        const matches = q === '' ? [] : commands.filter(c => `${c.name} ${c.description}`.toLowerCase().includes(q))
        const recentShown = recentList.filter(n => !pinList.includes(n) && byName.has(n)).slice(0, RECENT_MAX)
        const subFold = (key: string, label: string, count: number) => {
          const open = isOpen(key)
          return (
            <Box paddingLeft={2}>
              <Button key={`fold:${key}`} plain onPress={() => void setFold($, key, !open)}>
                <Text color={accent}>{open ? '− ' : '+ '}</Text>
                <Text color="inactive">
                  {label} · {count}
                </Text>
              </Button>
            </Box>
          )
        }
        const plugins = commands.filter(c => c.source === 'plugin')
        const mcps = commands.filter(c => c.source === 'mcp')

        // ---- preferences (the former Settings tab)
        const toggle = (label: string, key: keyof Prefs, value: boolean, after?: (v: boolean) => Promise<void>) => (
          <Button
            key={`pref:${key}`}
            plain
            onPress={async () => {
              await savePrefs($, cur => ({ ...cur, [key]: !value }))
              if (after !== undefined) await after(!value)
            }}
          >
            <Text color={value ? 'success' : 'inactive'}>{value ? '[on] ' : '[  ] '}</Text>
            <Text color={value ? 'text' : 'inactive'}>{label}</Text>
          </Button>
        )

        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              {foldSection('pinned', 'pinned', String(pinList.length))}
              {isOpen('pinned') && (
                <Box flexDirection="column">
                  {pinList.length === 0 ? (
                    <Box paddingLeft={2}>
                      <Text color="inactive">Nothing pinned. Pin with ◇ in all commands.</Text>
                    </Box>
                  ) : (
                    grid(pinList, 'pin')
                  )}
                  <Box paddingLeft={2}>
                    <Button key="pin:edit" plain onPress={() => void update($, pinEdit, v => !v)}>
                      <Text color="inactive">{editing ? '− done' : '+ add or remove'}</Text>
                    </Button>
                  </Box>
                  {editing && (
                    <Box flexDirection="column" paddingLeft={2}>
                      <Input
                        key="pin:add"
                        label="add › "
                        placeholder="/compact keep the test results"
                        submitLabel="pin"
                        autoFocus
                        onSubmit={value => {
                          const line = value.trim().replace(/^\//, '').replace(/\s+/g, ' ')
                          if (line !== '') void setPins($, l => (l.includes(line) ? l : [...l, line]))
                        }}
                      />
                      {pinList.map(item => (
                        <Button
                          key={`pin:rm:${item}`}
                          plain
                          onPress={() => void setPins($, l => l.filter(x => x !== item))}
                        >
                          <Text color="error">× </Text>
                          <Text color="inactive">/{item}</Text>
                        </Button>
                      ))}
                    </Box>
                  )}
                </Box>
              )}
            </Box>

            <Box flexDirection="column">
              {foldSection('recent', 'recent', String(recentShown.length))}
              {isOpen('recent') &&
                (recentShown.length === 0 ? (
                  <Box paddingLeft={2}>
                    <Text color="inactive">Commands you run show up here.</Text>
                  </Box>
                ) : (
                  grid(recentShown, 'recent')
                ))}
            </Box>

            <Box flexDirection="column">
              {foldSection('all', 'all commands', String(commands.length))}
              {isOpen('all') && (
                <Box flexDirection="column" rowGap={1}>
                  <Box paddingLeft={2}>
                    <Input
                      key="cmd:filter"
                      label="filter › "
                      placeholder="type to narrow"
                      value={filter}
                      onInput={value => void update($, cmdFilter, () => value)}
                      onSubmit={value => void update($, cmdFilter, () => value)}
                    />
                  </Box>
                  {q !== '' ? (
                    matches.length === 0 ? (
                      <Box paddingLeft={2}>
                        <Text color="inactive">No command matches.</Text>
                      </Box>
                    ) : (
                      group(`${matches.length} found`, matches, 'match')
                    )
                  ) : (
                    <Box flexDirection="column" rowGap={1}>
                      {COMMAND_GROUPS.map(([label, names]) =>
                        group(
                          label,
                          names.map(n => byName.get(n)).filter((c): c is NonNullable<typeof c> => c !== undefined),
                          `g:${label}`,
                        ),
                      )}
                      {group(
                        'other built-ins',
                        builtins.filter(c => !mapped.has(c.name)),
                        'g:other',
                      )}
                      {group(
                        'your commands',
                        commands.filter(c => c.source === 'user'),
                        'g:user',
                      )}
                      {plugins.length > 0 && (
                        <Box flexDirection="column">
                          {subFold('all:skills', 'skills & plugins', plugins.length)}
                          {isOpen('all:skills') && plugins.map(c => listRow(c, 'g:plugin'))}
                        </Box>
                      )}
                      {mcps.length > 0 && (
                        <Box flexDirection="column">
                          {subFold('all:mcp', 'mcp', mcps.length)}
                          {isOpen('all:mcp') && mcps.map(c => listRow(c, 'g:mcp'))}
                        </Box>
                      )}
                    </Box>
                  )}
                </Box>
              )}
            </Box>

            <Box flexDirection="column">
              {foldSection('colors', 'colors', draft.preset)}
              {isOpen('colors') && (
                <Box flexDirection="column" paddingLeft={2}>
                  <Box flexDirection="row" columnGap={1}>
                    <Box width={13} flexShrink={0}>
                      <Text color="inactive">start from</Text>
                    </Box>
                    {Object.keys(COLOR_PRESETS).map(name => (
                      <Button
                        key={`preset:${name}`}
                        plain
                        onPress={() =>
                          void setColors($, { preset: name, colors: { ...(COLOR_PRESETS[name]?.colors ?? {}) } })
                        }
                      >
                        <Text color={name === draft.preset ? accent : 'inactive'} bold={name === draft.preset}>
                          {name}
                        </Text>
                      </Button>
                    ))}
                  </Box>
                  {COLOR_KEYS.map(([id, label]) => {
                    const hex = draft.colors[id] ?? COLOR_PRESETS.dark?.colors[id] ?? '#ffffff'
                    return (
                      <Box key={`color:${id}`} flexDirection="row">
                        <Box width={13} flexShrink={0}>
                          <Text color="inactive">{label}</Text>
                        </Box>
                        {colorEditing === id ? (
                          <Input
                            key={`color:in:${id}`}
                            placeholder="#rrggbb"
                            value={hex}
                            submitLabel="set"
                            autoFocus
                            onSubmit={value => {
                              const v = value.trim()
                              if (!/^#[0-9a-fA-F]{6}$/.test(v)) {
                                $.ui.toast('A color is # and six hex digits, like #ff79c6')
                                return
                              }
                              void (async () => {
                                await setColors($, { ...draft, colors: { ...draft.colors, [id]: v.toLowerCase() } })
                                await update($, colorEdit, () => null)
                              })()
                            }}
                          />
                        ) : (
                          <Button key={`color:btn:${id}`} plain onPress={() => void update($, colorEdit, () => id)}>
                            <Text backgroundColor={hex}>{'  '}</Text>
                            <Text> {hex}</Text>
                          </Button>
                        )}
                      </Box>
                    )
                  })}
                  <Box flexDirection="row" columnGap={2} marginTop={1}>
                    <Button key="colors:save" plain onPress={() => void saveMineTheme($)}>
                      <Text color="success" bold>
                        save as my theme
                      </Text>
                    </Button>
                    <Button
                      key="colors:reset"
                      plain
                      onPress={() => void setColors($, { preset: 'dark', colors: { ...(COLOR_PRESETS.dark?.colors ?? {}) } })}
                    >
                      <Text color="inactive">reset</Text>
                    </Button>
                  </Box>
                  <Text color="inactive" wrap="wrap">
                    Saved as "{MINE_THEME_NAME}". Pick it once in /theme: Claude Code does not switch themes while running.
                  </Text>
                </Box>
              )}
            </Box>

            <Box flexDirection="column">
              {foldSection('prefs', 'preferences')}
              {isOpen('prefs') && (
                <Box flexDirection="column" paddingLeft={2} rowGap={1}>
                  <Box flexDirection="column">
                    <Text color="inactive">transcript</Text>
                    {toggle('one-line tool rows in frames', 'compactRows', p.compactRows)}
                    {toggle('move Claude Code notices to the panel', 'hideNotices', p.hideNotices)}
                    {toggle('color @files and /commands as you type', 'paint', p.paint)}
                  </Box>
                  <Box flexDirection="column">
                    <Text color="inactive">alerts and keys</Text>
                    {toggle('notify when a long turn ends', 'alarm', p.alarm)}
                    {toggle(`${HOTKEY} focuses the panel`, 'hotkey', p.hotkey, v => syncBindings($, 'focus', v, true))}
                    {toggle('arrows: ←→ tabs, ↑↓ inside the tab', 'lockArrows', p.lockArrows, v => syncBindings($, 'arrows', v, true))}
                    {toggle('← never opens agent view', 'leftArrowOff', p.leftArrowOff, v => syncLeftArrow($, !v, true))}
                  </Box>
                  <Box flexDirection="column">
                    <Text color="inactive">data</Text>
                    <Button
                      key="reset"
                      plain
                      onPress={async () => {
                        await update($, edits, () => [])
                        await update($, activity, () => [])
                        await update($, turns, () => [])
                        await update($, totals, () => EMPTY_TOTALS)
                        await update($, notices, () => [])
                        await update($, expandedFile, () => null)
                        await update($, pickedTurn, () => null)
                        $.ui.toast('Counters, files and history reset')
                      }}
                    >
                      <Text color="error">reset counters, files and history</Text>
                    </Button>
                  </Box>
                </Box>
              )}
            </Box>
          </Box>
        )
        break
      }
    }

    // Docked, the frame has a fixed height: fill it so the footer sits on its last row.
    const minHeight = e.props.placement === 'dock' ? Math.max(0, e.props.scroll.bodyRows) : undefined
    const stops = controlKeys([body, footer]).filter(key => !key.startsWith('dot:'))
    ring = { first: stops[0], last: stops[stops.length - 1] }
    return (
      <Box flexDirection="column" rowGap={1} minHeight={minHeight}>
        {header}
        <Box flexDirection="column" flexGrow={1}>
          {body}
        </Box>
        {footer}
      </Box>
    )
  })
}
