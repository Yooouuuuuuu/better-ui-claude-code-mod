/** One file Claude edited this session. `diff` is the last edit as a unified diff, when it fit. */
export type FileStat = { adds: number; dels: number; edits: number; last: number; diff?: string }

/** One tool call, for the recent list and the compact rows. */
export type Activity = {
  id: string
  tool: string
  label: string
  status: 'run' | 'ok' | 'err'
  at: number
  ms?: number
}

/** One finished turn of the main conversation. */
export type TurnRec = {
  n: number
  seconds: number
  tools: number
  errors: number
  tokens: number
  usd?: number
  reason: string
  promptId?: string
  /** The first words of the prompt that started the turn. */
  prompt?: string
  /** How many lines Claude's reply ran to. */
  replyLines?: number
  at: number
}

/** Session-wide counters. */
export type Totals = {
  calls: number
  errors: number
  byTool: Record<string, number>
  streak: number
  bestStreak: number
  testsPassed: number
  testsFailed: number
  biggestEdit: number
}

/** An engine notice taken out of the transcript and shown in the pane. */
export type Notice = { text: string; command: string | null; at: number }

/** The turn in progress on the main loop. */
export type Running = { startedAt: number; promptId?: string }

/** Preferences, also kept in $.store across sessions. */
export type Prefs = {
  compactRows: boolean
  alarm: boolean
  hideNotices: boolean
  tips: boolean
  paint: boolean
  skin: string
  /** Keep the panel's focus shortcut installed in ~/.claude/keybindings.json. */
  hotkey: boolean
  /** Keep the pane resize chords (ctrl+x with an arrow) unbound in keybindings.json. */
  lockSize: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'better-ui': {
      files: Shaped<Record<string, FileStat>>
      activity: Shaped<Activity[]>
      turns: Shaped<TurnRec[]>
      totals: Shaped<Totals>
      notices: Shaped<Notice[]>
      prompts: Shaped<Record<string, number>>
      prefs: Shaped<Prefs>
      running: Running | null
      tick: number
      tab: string
      expandedFile: string | null
      gitDirty: string[] | null
      /** The session's repo root, forward slashes; null outside a repo. */
      gitRoot: string | null
      /** The person closed the pane this session: a reload keeps it closed. */
      hidden: boolean
      /** Minimized: the pane is closed and one line above the prompt stands in for it. */
      mini: boolean
      /** Which Control and Overview sections are open, by key; kept in $.store. */
      folds: Record<string, boolean>
      /** Pinned command lines, without the slash (may carry arguments); kept in $.store. */
      pins: string[]
      /** Commands run lately, newest first; kept in $.store. */
      recent: string[]
      /** The all-commands filter text. */
      cmdFilter: string
      /** The pinned section's add-or-remove row is open. */
      pinEdit: boolean
      /** The colors being edited: a preset and the six colors; kept in $.store. */
      colorDraft: { preset: string; colors: Record<string, string> }
      /** Which color's hex field is open. */
      colorEdit: string | null
    }
  }
}
