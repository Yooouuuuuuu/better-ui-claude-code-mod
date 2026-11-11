import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, Timer } from 'claude-code'

import type { Activity, FileStat, Notice, Prefs, Running, Totals, TurnRec } from '../types'
import {
  EDIT_TOOLS,
  FOCUS_BINDINGS,
  KIND_COLOR,
  HOTKEY,
  LOCK_BINDINGS,
  TIPS,
  SKINS,
  achievements,
  bar,
  clip,
  countPatch,
  decoratePrompt,
  detectTests,
  extraFields,
  limitName,
  fmtMs,
  fmtSeconds,
  fmtTokens,
  fmtUsd,
  heatColor,
  hhmm,
  labelOf,
  mergeBindings,
  toolKind,
  shortResult,
  packCells,
  patchToDiff,
  rateTurn,
  rec,
  relTime,
  resultSummary,
  riskOf,
  shortPath,
  skinOf,
  sparkline,
  str,
  toolIcon,
} from './lib'

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
const TABS = ['Overview', 'Usage', 'History', 'Agents', 'Files', 'Settings'] as const
type Tab = (typeof TABS)[number]

const DEFAULT_PREFS: Prefs = {
  compactRows: true,
  alarm: true,
  hideNotices: true,
  tips: true,
  paint: true,
  skin: 'line',
  hotkey: true,
  lockSize: false,
  guardTui: true,
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

const files = atom({ plugin: 'better-ui', key: 'files' } as const, {} as Record<string, FileStat>, {
  shape: 'files-2',
})
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
const callTimes = atom({ plugin: 'better-ui', key: 'callTimes' } as const, [] as number[], {
  shape: 'calltimes-1',
})
const prefs = atom({ plugin: 'better-ui', key: 'prefs' } as const, DEFAULT_PREFS, { shape: 'prefs-1' })
const running = atom({ plugin: 'better-ui', key: 'running' } as const, null as Running | null)
const tick = atom({ plugin: 'better-ui', key: 'tick' } as const, 0)
const tab = atom({ plugin: 'better-ui', key: 'tab' } as const, 'Overview')
const expandedFile = atom({ plugin: 'better-ui', key: 'expandedFile' } as const, null as string | null)
const gitDirty = atom({ plugin: 'better-ui', key: 'gitDirty' } as const, null as string[] | null)
const hidden = atom({ plugin: 'better-ui', key: 'hidden' } as const, false)
const mini = atom({ plugin: 'better-ui', key: 'mini' } as const, false)
const rcState = atom({ plugin: 'better-ui', key: 'rc' } as const, null as boolean | null)

/**
 * Whether Remote Control is connected, read from Claude Code itself: its
 * /remote-control command describes itself as "Disconnect Remote Control"
 * while connected. null when the command is not there (logged out, disabled).
 */
async function rcLive($: CoreEngineInterface): Promise<boolean | null> {
  try {
    const cmd = (await $.command.list()).find(c => c.name === 'remote-control')
    return cmd === undefined ? null : /disconnect/i.test(cmd.description)
  } catch {
    return null
  }
}

/** Turns Remote Control on or off by running Claude Code's own command. */
async function rcToggle($: CoreEngineInterface): Promise<void> {
  try {
    await $.command.run({ command: 'remote-control' })
  } catch (err) {
    $.ui.toast(`Remote Control: ${err instanceof Error ? err.message : String(err)}`)
  }
  const now = await rcLive($)
  await update($, rcState, () => now)
}

/** Closes the pane and shows the one-line band in its place. */
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
    ? 'Better UI shown. 1–6 or a/d switch tabs, m minimizes, Esc returns to the prompt.'
    : `Better UI is waiting for room: ${opened.reason}`
}

// ---------------------------------------------------------------------------
// Helpers that use $
// ---------------------------------------------------------------------------

async function notify($: CoreEngineInterface, text: string): Promise<void> {
  try {
    const sent = await $.ui.notify(text, { title: TITLE })
    if (!sent.isSent) $.ui.toast(text)
  } catch {
    $.ui.toast(text)
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
async function syncBindings(
  $: CoreEngineInterface,
  which: 'focus' | 'lock',
  want: boolean,
  loud: boolean,
): Promise<void> {
  const entries = which === 'focus' ? FOCUS_BINDINGS : LOCK_BINDINGS
  const name = which === 'focus' ? `${HOTKEY} shortcut` : 'pane size lock'
  try {
    const path = await keybindingsPath($)
    const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : null
    const r = mergeBindings(typeof existing === 'string' ? existing : null, entries, want)
    if (r.text !== undefined) await $.fs.write(path, r.text)
    switch (r.outcome) {
      case 'installed':
        $.ui.toast(`${name} installed (keybindings.json)`)
        break
      case 'removed':
        $.ui.toast(`${name} removed (keybindings.json)`)
        break
      case 'occupied':
        $.ui.toast(`${name}: a key is already bound to something else; not installed`)
        break
      case 'unparsable':
        if (loud || want) $.ui.toast(`keybindings.json could not be parsed; ${name} left alone`)
        break
      default:
        if (loud) $.ui.toast(want ? `${name} already installed` : `${name} was not installed`)
    }
  } catch (err) {
    if (loud) $.ui.toast(`${name}: ${err instanceof Error ? err.message : String(err)}`)
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
      $.ui.toast(
        hadDir
          ? 'Better UI themes installed: pick one in /theme'
          : 'Better UI themes installed: restart Claude Code once, then pick one in /theme',
      )
    }
  } catch (err) {
    $.ui.toast(`Better UI themes not installed: ${err instanceof Error ? err.message : String(err)}`)
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
async function refreshGit($: CoreEngineInterface): Promise<void> {
  try {
    const ran = await $.process.run(['git', 'status', '--porcelain', '--untracked-files=all'], {
      timeoutMs: 8000,
    })
    if (ran.exitCode !== 0) {
      await update($, gitDirty, () => null)
      return
    }
    const paths = ran.stdout
      .split('\n')
      .filter(l => l.length > 3)
      .map(l => l.slice(3).trim().replace(/^"|"$/g, '').replace(/.* -> /, '').replace(/\\/g, '/'))
    await update($, gitDirty, () => paths)
  } catch {
    await update($, gitDirty, () => null)
  }
}

const isDirty = (dirty: string[] | null, path: string): boolean | undefined => {
  if (dirty === null) return undefined
  const p = path.replace(/\\/g, '/')
  return dirty.some(d => p.endsWith('/' + d) || p === d)
}

// ---------------------------------------------------------------------------
// The mod
// ---------------------------------------------------------------------------

export const register: Register = on => {
  let toolsThisTurn = 0
  let errorsThisTurn = 0
  let pendingPromptId: string | undefined
  let lastPromptText = ''
  let ticker: Timer | undefined
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

    void syncBindings($, 'focus', merged.hotkey, false)
    void installThemes($)
    void syncBindings($, 'lock', merged.lockSize, false)
    void refreshGit($)
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

  // ---- Remote Control -----------------------------------------------------------

  // However /remote-control is run (typed, /rc, the panel's button), record the
  // state it leaves, so the panel and the minimized line redraw.
  on('command.run', { command: 'remote-control' }, async ($, e, next) => {
    const out = await next(e)
    const state = await rcLive($)
    await update($, rcState, () => state)
    return out
  }).catch(($, e, next) => (next.called ? next(e) : next(e)))

  // ---- the minimized line above the prompt --------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, mini))) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [p, run, turnList, noteList, pct, liveAgents, roster] = await Promise.all([
      read($, prefs),
      read($, running),
      read($, turns),
      read($, notices),
      contextPercent($),
      liveAgentCount($),
      rcLive($),
    ])
    const remote = roster === true
    await read($, rcState)
    const skin = skinOf(p.skin)
    const now = await $.clock.now()
    const pctColor = pct === null ? 'subtle' : pct >= 85 ? 'error' : pct >= 60 ? 'warning' : 'success'
    const elapsed = run === null ? 0 : Math.round((now - run.startedAt) / 1000)
    const turnText = run !== null ? `turn ${turnList.length + 1}` : `turn ${turnList[turnList.length - 1]?.n ?? 0}`
    const latest = noteList[noteList.length - 1]
    return (
      <Box flexDirection="row" gap={1}>
        <Text color={run === null ? 'success' : 'warning'}>{run === null ? skin.ok : skin.run}</Text>
        <Text bold>{run === null ? 'idle' : `working ${fmtSeconds(elapsed)}`}</Text>
        <Text dimColor>·</Text>
        <Text dimColor>context</Text>
        <Text color={pctColor}>{pct === null ? '—' : `${pct}%`}</Text>
        <Text dimColor>· {turnText}</Text>
        <Text color={liveAgents > 0 ? 'warning' : 'subtle'}>
          · {liveAgents} {liveAgents === 1 ? 'agent' : 'agents'}
        </Text>
        {remote && <Text color="cyan_FOR_SUBAGENTS_ONLY">· rc on</Text>}
        {latest !== undefined && (
          <Text dimColor wrap="truncate-end">
            · {latest.text}
          </Text>
        )}
        <Button key="expand" label="open" onPress={() => void expand($)} />
      </Box>
    )
  })

  // /tui restarts the renderer through a fresh session id, which drops the
  // session's dev-mods folder: the pane and /better-ui vanish. Answer it here.
  on('command.run', { command: 'tui' }, async ($, e, next) => {
    const p = await read($, prefs)
    if (!p.guardTui) return next(e)
    const current = e.presentation.isFullscreen ? 'fullscreen' : 'default'
    const wanted = e.args.trim()
    if (wanted === '' || wanted === current) {
      return { text: `Current renderer: ${current}. (/tui is guarded by Better UI: it would restart the session and unload this mod. Turn the guard off in Settings to run it.)` }
    }
    return {
      text: `Not switching to "${wanted}": /tui restarts the session under a new id, which unloads Better UI. To switch, turn the guard off in Better UI's Settings and run /tui again, or set "tui" in settings.json and start a new session.`,
    }
  }).catch(($, e, next) => (next.called ? next(e) : { text: 'Better UI could not guard /tui.' }))


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
        await update($, notices, list => [...list, { text, command: null, at: now }].slice(-50))
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- turns ---------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    toolsThisTurn = 0
    errorsThisTurn = 0
    let costAtStart: number | undefined
    try {
      costAtStart = (await $.session.usage()).cost?.usd
    } catch {
      costAtStart = undefined
    }
    await update($, running, () => ({ startedAt: now, promptId: pendingPromptId, costAtStart }))
    pendingPromptId = undefined
    ticker?.cancel()
    ticker = $.clock.every(250, () => void update($, tick, n => (n + 1) % 1_000_000))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent finished: say which one.
      try {
        const agent = (await $.agent.list()).find(a => a.id === e.agentId)
        $.ui.toast(`Agent done: ${clip(agent?.description ?? e.agentId, 50)}`)
      } catch {
        /* no agent list: stay quiet */
      }
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
    let usd: number | undefined
    try {
      const after = (await $.session.usage()).cost?.usd
      if (after !== undefined && run?.costAtStart !== undefined) usd = Math.max(0, after - run.costAtStart)
    } catch {
      usd = undefined
    }

    const list = await read($, turns)
    const n = (list[list.length - 1]?.n ?? 0) + 1
    const record: TurnRec = {
      n,
      seconds,
      tools,
      errors,
      tokens,
      usd,
      reason: e.reason,
      promptId: run?.promptId,
      prompt: lastPromptText === '' ? undefined : lastPromptText,
      at: now,
    }
    await update($, turns, l => [...l, record].slice(-100))

    const clean = errors === 0 && e.reason === 'answer' && !e.isAborted
    const tot = await update($, totals, t => {
      const streak = clean ? t.streak + 1 : 0
      return { ...t, streak, bestStreak: Math.max(t.bestStreak, streak) }
    })
    if (clean && tot.streak > 0 && tot.streak % 5 === 0) {
      $.ui.toast(`Streak ×${tot.streak}: ${tot.streak} clean turns in a row`)
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
        $.ui.toast(`Account usage at ${Math.round(worst)}% of a rate-limit window`)
      }
    } catch {
      /* no usage figures */
    }

    void refreshGit($)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- tool calls ----------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const id = e.tool_use_id ?? `${e.tool}-${startedAt}`
    const entry: Activity = { id, tool: e.tool, label: labelOf(e.tool, e), status: 'run', at: startedAt }
    toolsThisTurn += 1

    await update($, activity, list => [...list, entry].slice(-60))
    await update($, callTimes, list => [...list, startedAt].slice(-2000))
    await update($, totals, t => ({
      ...t,
      calls: t.calls + 1,
      byTool: { ...t.byTool, [e.tool]: (t.byTool[e.tool] ?? 0) + 1 },
    }))

    const ran = await next(e)

    const ms = (await $.clock.now()) - startedAt
    const isError = ran.deny !== undefined || ran.isError === true
    const status: Activity['status'] = isError ? 'err' : 'ok'
    await update($, activity, list => list.map(a => (a.id === id ? { ...a, status, ms } : a)))
    if (isError) {
      errorsThisTurn += 1
      await update($, totals, t => ({ ...t, errors: t.errors + 1 }))
    }

    if (!isError && EDIT_TOOLS.has(e.tool)) {
      const input = rec(e)
      const path = str(input.file_path) ?? str(input.notebook_path)
      const patch = countPatch(ran.result)
      const diff = patchToDiff(ran.result)
      const changed = (patch?.adds ?? 0) + (patch?.dels ?? 0)
      if (path !== undefined) {
        await update($, files, map => {
          const prev = map[path] ?? { adds: 0, dels: 0, edits: 0, last: 0 }
          const stat: FileStat = {
            adds: prev.adds + (patch?.adds ?? 0),
            dels: prev.dels + (patch?.dels ?? 0),
            edits: prev.edits + 1,
            last: startedAt,
          }
          if (diff !== undefined) stat.diff = diff
          return { ...map, [path]: stat }
        })
        if (changed >= BIG_EDIT_LINES) {
          $.ui.toast(`Big edit: ${changed} lines in ${shortPath(path)}`)
        }
        await update($, totals, t => ({ ...t, biggestEdit: Math.max(t.biggestEdit, changed) }))
      }
    }

    if (e.tool === 'Bash' && ran.deny === undefined) {
      const out = rec(ran.result)
      const tests = detectTests(str(rec(e).command) ?? '', str(out.stdout) ?? '', str(out.stderr) ?? '')
      if (tests !== undefined) {
        await update($, totals, t => ({
          ...t,
          testsPassed: t.testsPassed + tests.passed,
          testsFailed: t.testsFailed + tests.failed,
        }))
        $.ui.toast(
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
      const stat = path === undefined ? undefined : (await read($, files))[path]
      if (stat !== undefined) {
        text = `Edited ${stat.edits}× this session (+${stat.adds} −${stat.dels})`
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
    if (e.props.isDraft || e.props.isWorking || !(await read($, prefs)).tips) return next(e)
    const count = (await read($, turns)).length
    const tip = TIPS[count % TIPS.length] ?? ''
    return next({ ...e, props: { ...e.props, tail: ` · ${tip}` } })
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
  on('ui.render', { component: 'TurnDuration' }, async ($, e, next) => {
    if (e.props.isExpanded === true || e.props.waitingFor !== undefined) return next(e)
    const list = await read($, turns)
    const t = list[list.length - 1]
    if (t === undefined || Math.abs(t.seconds * 1000 - e.props.durationMs) > 2500) return next(e)
    const p = await read($, prefs)
    const { Box, Text } = $.ui.resolve(e)
    const rating = rateTurn(t.seconds, t.errors, t.reason)
    const outcome =
      t.reason === 'aborted' ? { mark: '■ stopped', tone: 'warning' }
      : t.reason === 'error' ? { mark: '× error', tone: 'error' }
      : t.reason === 'refusal' ? { mark: '× refused', tone: 'error' }
      : { mark: 'done', tone: rating === 'slow' ? 'warning' : 'success' }
    const ruleTone = outcome.tone
    return (
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Text color={ruleTone} dimColor>
          ──
        </Text>
        <Box flexShrink={0}>
          <Text color={outcome.tone} bold>
            {outcome.mark}
          </Text>
        </Box>
        <Box flexShrink={0}>
          <Text color="inactive">
            in {fmtSeconds(t.seconds)} · {t.tools} {t.tools === 1 ? 'tool' : 'tools'}
            {t.errors > 0 && <Text color="error"> · {t.errors} failed</Text>} · ↓ {fmtTokens(t.tokens)} tok
          </Text>
        </Box>
        {t.reason === 'answer' && rating === 'fast' && (
          <Box flexShrink={0}>
            <Text color="yellow_FOR_SUBAGENTS_ONLY">» fast</Text>
          </Box>
        )}
        <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
          <Text color={ruleTone} dimColor wrap="wrap">
            {'─'.repeat(400)}
          </Text>
        </Box>
      </Box>
    )
  })

  // ---- transcript rows -----------------------------------------------------

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
    const p = await read($, prefs)
    const { Box, Text, Markdown } = $.ui.resolve(e)
    const long = e.props.text.length >= 1200
    const lines = e.props.text.split('\n').length
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
          {long && (
            <Text color="inactive">
              <Text color="permission">◇ </Text>
              {lines} lines · ~{fmtTokens(Math.round(e.props.text.length / 4))} tok
            </Text>
          )}
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
          await update($, notices, list => [...list, { text: e.props.text, command, at: now }].slice(-50))
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
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const cols = Math.max(24, e.props.bodyColumns)
    const now = await $.clock.now()
    const [p, current, fileMap, turnList, noteList, run, dirty, expanded] = await Promise.all([
      read($, prefs),
      read($, tab),
      read($, files),
      read($, turns),
      read($, notices),
      read($, running),
      read($, gitDirty),
      read($, expandedFile),
    ])
    const c = true
    const accent = c ? 'pink_FOR_SUBAGENTS_ONLY' : 'claude'
    const active = (TABS as readonly string[]).includes(current) ? (current as Tab) : 'Overview'
    const at = TABS.indexOf(active)
    const go = (name: Tab) => update($, tab, () => name)
    const step = (by: number) => go(TABS[(at + by + TABS.length) % TABS.length] ?? 'Overview')

    // ---- shared pieces
    const rule = (color = 'subtle') => (
      <Box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        <Text color={color} wrap="wrap">
          {'─'.repeat(400)}
        </Text>
      </Box>
    )
    const section = (label: string, right?: string) => (
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={0}>
          <Text color="inactive">{label}</Text>
        </Box>
        {rule()}
        {right !== undefined && (
          <Box flexShrink={0}>
            <Text color="inactive">{right}</Text>
          </Box>
        )}
      </Box>
    )
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
    const levelTone = (pct: number) =>
      pct >= 90 ? 'error' : pct >= 70 ? 'warning' : c ? 'success' : 'inactive'
    const clock = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`

    // ---- top bar: the tab's name, then one dot per tab (clickable)
    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Box flexShrink={0}>
            <Text color={c ? accent : 'text'} bold>
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
      <Box flexDirection="row" justifyContent="flex-end">
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
        const [pct, liveAgents, rc] = await Promise.all([contextPercent($), liveAgentCount($), rcLive($)])
        await read($, rcState)
        const elapsed = run === null ? 0 : Math.max(0, Math.round((now - run.startedAt) / 1000))
        const turnNo = run !== null ? turnList.length + 1 : (turnList[turnList.length - 1]?.n ?? 0)
        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text color={run === null ? 'success' : 'warning'}>●</Text>
                <Text bold>{run === null ? 'idle' : 'working'}</Text>
                {run !== null && <Text color={c ? 'yellow_FOR_SUBAGENTS_ONLY' : 'inactive'}>{clock(elapsed)}</Text>}
              </Box>
              {field(
                'context',
                pct === null ? '—' : meter(pct, levelTone(pct)),
                <Text color={pct === null ? 'inactive' : levelTone(pct)}>{pct === null ? '' : `${pct}%`}</Text>,
              )}
              {field('turn', String(turnNo))}
              {field(
                'agents',
                <Text color={liveAgents > 0 ? (c ? 'purple_FOR_SUBAGENTS_ONLY' : 'text') : 'inactive'}>
                  {liveAgents > 0 ? `${liveAgents} running` : 'none running'}
                </Text>,
              )}
            </Box>
            <Box flexDirection="column">
              {section('remote control')}
              {rc === null ? (
                <Text color="inactive">not available here</Text>
              ) : (
                <Button key="rc" plain onPress={() => void rcToggle($)}>
                  <Text color={rc ? 'cyan_FOR_SUBAGENTS_ONLY' : 'inactive'} inverse={rc} bold={rc}>
                    {' on '}
                  </Text>
                  <Text color={rc ? 'inactive' : 'text'} inverse={!rc} bold={!rc}>
                    {' off '}
                  </Text>
                  <Text color="inactive">{rc ? '  click to disconnect' : '  click to connect'}</Text>
                </Button>
              )}
            </Box>
            <Box flexDirection="column">
              {section('notices', String(noteList.length))}
              {noteList.length === 0 && <Text color="inactive">Nothing from the engine yet.</Text>}
              {noteList
                .slice(-8)
                .reverse()
                .map((nt, i) => (
                  <Box key={`note:${i}`} flexDirection="row" columnGap={1}>
                    <Box width={5} flexShrink={0}>
                      <Text color="inactive">{hhmm(nt.at)}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="truncate-end">{nt.text}</Text>
                    </Box>
                    {nt.command !== null && <Text color={c ? 'cyan_FOR_SUBAGENTS_ONLY' : 'inactive'}>{nt.command}</Text>}
                  </Box>
                ))}
            </Box>
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
              {field('written', <Text color={c ? 'cyan_FOR_SUBAGENTS_ONLY' : 'text'}>↓ {fmtTokens(written)} tok</Text>)}
              {field(
                'turns',
                <Text>
                  {turnList.length}
                  <Text color="inactive">
                    {' '}
                    · {fmtSeconds(worked)} working{usage !== undefined ? ` · since ${hhmm(usage.startedAt)}` : ''}
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
        const rows = [...turnList].reverse().slice(0, 40)
        const worked = turnList.reduce((n, t) => n + t.seconds, 0)
        const longest = Math.max(1, ...rows.map(t => t.seconds))
        const BAR = 8
        const mins = (secs: number) => (secs < 60 ? '<1m' : `${Math.round(secs / 60)}m`)
        const label = (n: number) => `turn ${n}`
        const labelW = Math.max(6, ...rows.map(t => label(t.n).length))
        const textW = Math.max(8, cols - labelW - 1 - 6 - BAR - 5 - 2)
        body = (
          <Box flexDirection="column" rowGap={1}>
            <Text color="inactive">
              {turnList.length} {turnList.length === 1 ? 'turn' : 'turns'} total · {mins(worked)} working
            </Text>
            {rows.length === 0 && <Text color="inactive">No turns finished yet.</Text>}
            {rows.map(t => {
              const slow = rateTurn(t.seconds, 0, 'answer') === 'slow'
              const barLen = Math.max(1, Math.round((t.seconds / longest) * BAR))
              const jump = async () => {
                if (t.promptId === undefined) {
                  $.ui.toast(`Turn ${t.n}: no prompt row to jump to`)
                  return
                }
                const r = await $.ui.scroll({ to: { requestId: t.promptId }, block: 'start' })
                if (r.deny !== undefined) $.ui.toast(`Turn ${t.n} is no longer on screen`)
              }
              const words = clip((t.prompt ?? '(prompt not recorded)').replace(/\s+/g, ' '), textW).padEnd(textW)
              return (
                <Box key={`turn:${t.n}`} flexDirection="column">
                  <Button key={`turnbtn:${t.n}`} plain onPress={jump}>
                    <Text color="pink_FOR_SUBAGENTS_ONLY" bold>
                      {label(t.n).padEnd(labelW)}{' '}
                    </Text>
                    <Text color="inactive">{hhmm(t.at)} </Text>
                    <Text color={t.prompt === undefined ? 'inactive' : 'text'}>{words} </Text>
                    <Text color={slow ? 'warning' : c ? 'cyan_FOR_SUBAGENTS_ONLY' : 'subtle'}>
                      {'▬'.repeat(barLen).padEnd(BAR)}
                    </Text>
                    <Text color={slow ? 'warning' : 'inactive'}> {mins(t.seconds).padStart(4)}</Text>
                  </Button>
                  <Box paddingLeft={labelW + 7}>
                    <Text color="inactive">
                      {t.tools} {t.tools === 1 ? 'tool' : 'tools'}
                      {t.errors > 0 && <Text color="error"> · {t.errors} failed</Text>}
                      {t.reason === 'aborted' && <Text color="warning"> · ■ stopped</Text>}
                      {(t.reason === 'error' || t.reason === 'refusal') && <Text color="error"> · × {t.reason}</Text>}
                    </Text>
                  </Box>
                </Box>
              )
            })}
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
                    <Text color="warning">● </Text>
                    <Text color={c ? 'purple_FOR_SUBAGENTS_ONLY' : 'text'} bold>
                      ◆ {a.name ?? a.type}
                    </Text>
                    <Text color="inactive"> {a.status}</Text>
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

      case 'Files': {
        const rows = Object.entries(fileMap).sort((a, b) => b[1].last - a[1].last)
        const adds = rows.reduce((n, [, f]) => n + f.adds, 0)
        const dels = rows.reduce((n, [, f]) => n + f.dels, 0)
        const biggest = Math.max(1, ...rows.map(([, f]) => f.adds + f.dels))
        const BARS = 6
        const pathW = Math.max(8, cols - 2 - BARS - 6 - 3)
        const openFile = expanded === null ? undefined : fileMap[expanded]
        body = (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="row" columnGap={1}>
              <Text>
                {rows.length} {rows.length === 1 ? 'file' : 'files'}
              </Text>
              <Text color="success">+{adds}</Text>
              <Text color="error">−{dels}</Text>
              <Box flexGrow={1} />
              {dirty === null ? (
                <Text color="inactive">not a git repo</Text>
              ) : (
                <Text>
                  <Text color="warning">●</Text>
                  <Text color="inactive"> not committed</Text>
                </Text>
              )}
            </Box>
            <Box flexDirection="column">
              {rows.length === 0 && <Text color="inactive">No edits yet.</Text>}
              {rows.map(([path, f]) => {
                const d = isDirty(dirty, path)
                const isOpen = expanded === path
                const total = f.adds + f.dels
                const cells = Math.max(1, Math.round((total / biggest) * BARS))
                const addCells = total === 0 ? 0 : Math.round((f.adds / total) * cells)
                const name = clip(shortPath(path), pathW).padEnd(pathW)
                return (
                  <Button
                    key={`file:${path}`}
                    plain
                    onPress={() => update($, expandedFile, cur => (cur === path ? null : path))}
                  >
                    <Text color={d === true ? 'warning' : 'inactive'}>{d === true ? '● ' : '· '}</Text>
                    <Text bold={isOpen} color={d === false ? 'inactive' : 'text'}>
                      {name}{' '}
                    </Text>
                    {c ? (
                      <Text>
                        <Text color="success">{'▮'.repeat(addCells)}</Text>
                        <Text color="error">{'▮'.repeat(cells - addCells)}</Text>
                        {' '.repeat(BARS - cells)}
                      </Text>
                    ) : (
                      <Text color="inactive">{`+${f.adds} −${f.dels}`.padEnd(BARS).slice(0, BARS + 4)}</Text>
                    )}
                    <Text color="inactive"> {`${f.edits}×`.padStart(4)}</Text>
                  </Button>
                )
              })}
            </Box>
            {openFile !== undefined && expanded !== null && (
              <Box flexDirection="column" borderStyle="round" borderColor="inactive" borderDimColor paddingX={1}>
                <Text color="inactive">
                  {shortPath(expanded)} · last edit · {hhmm(openFile.last)}
                </Text>
                {openFile.diff !== undefined ? (
                  <Code format="diff" source={openFile.diff} path={expanded} wrap="truncate-end" />
                ) : (
                  <Text color="inactive">No diff was recorded for the last edit.</Text>
                )}
              </Box>
            )}
          </Box>
        )
        break
      }

      case 'Settings': {
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
              {section('transcript')}
              {toggle('one-line tool rows in frames', 'compactRows', p.compactRows)}
              {toggle('move engine notices to the panel', 'hideNotices', p.hideNotices)}
              {toggle('color @files and /commands as you type', 'paint', p.paint)}
              {toggle('tips under the prompt', 'tips', p.tips)}
            </Box>
            <Box flexDirection="column">
              {section('alerts and keys')}
              {toggle('notify when a long turn ends', 'alarm', p.alarm)}
              {toggle(`${HOTKEY} focuses the panel`, 'hotkey', p.hotkey, v => syncBindings($, 'focus', v, true))}
              {toggle('guard /tui (it restarts the session)', 'guardTui', p.guardTui)}
            </Box>
            <Box flexDirection="column">
              {section('data')}
              <Button
                key="reset"
                plain
                onPress={async () => {
                  await update($, files, () => ({}))
                  await update($, activity, () => [])
                  await update($, turns, () => [])
                  await update($, totals, () => EMPTY_TOTALS)
                  await update($, notices, () => [])
                  await update($, callTimes, () => [])
                  await update($, expandedFile, () => null)
                  $.ui.toast('Counters, files and history reset')
                }}
              >
                <Text color="error">reset counters, files and history</Text>
              </Button>
            </Box>
          </Box>
        )
        break
      }
    }

    // Docked, the frame has a fixed height: fill it so the footer sits on its last row.
    const minHeight = e.props.placement === 'dock' ? Math.max(0, e.props.scroll.bodyRows) : undefined
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
